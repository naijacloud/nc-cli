/**
 * The destructive-statement guard behind `db query` and `db shell` (TGL-1168).
 *
 * The server runs the whole input string (`psql -c` / `mysql -e`), so a guard
 * that reads only the first keyword is bypassed by `BEGIN; DROP TABLE t;
 * COMMIT;`, and one that greps the raw text for WHERE is bypassed by
 * `DELETE FROM t -- WHERE id = 1`. This module therefore:
 *
 *   1. Lexes the input: string literals, quoted identifiers, dollar-quoted
 *      bodies and comments are recognised, so neither a keyword inside a string
 *      nor a WHERE inside a comment counts.
 *   2. Splits it into statements on `;` outside all of the above.
 *   3. Classifies every statement, not just the first.
 *
 * It fails closed: when the lexer cannot be sure what the server will see (an
 * unterminated quote or comment, a backslash whose meaning differs between
 * engines, MySQL's executable `/*! … *\/` comments, a `DO` block or a dynamic
 * `EXECUTE`), it reports a reason, so the caller asks rather than runs.
 */

/** The SQL dialect, which decides what counts as a comment. */
export type SqlDialect = "postgres" | "mysql";

interface Token {
  /** Upper-cased word, or the punctuation character itself. */
  text: string;
  /** Parenthesis depth the token sits at. */
  depth: number;
}

interface Lexed {
  /** Statements as token lists; empty statements are dropped. */
  statements: Token[][];
  /** Set when the lexer met something whose meaning it cannot be sure of. */
  unsure: string | null;
}

/**
 * Tokenises `sql` into statements.
 *
 * `backslashEscapes` decides whether `\'` ends a single-quoted string. MySQL
 * treats it as an escape and standard Postgres strings do not, and the two
 * readings can split the same text differently — so the caller lexes both ways
 * and treats a disagreement as "unsure".
 */
function lex(sql: string, dialect: SqlDialect, backslashEscapes: boolean): Lexed {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  let unsure: string | null = null;
  let index = 0;

  const flush = (): void => {
    if (current.length > 0) statements.push(current);
    current = [];
    depth = 0;
  };

  while (index < sql.length) {
    const char = sql[index] as string;
    const next = sql[index + 1];

    // -- line comment. MySQL needs whitespace after it; `--x` is an operator
    // pair there, so a bare `--x` is something we cannot read safely.
    if (char === "-" && next === "-") {
      if (dialect === "mysql" && !/\s/.test(sql[index + 2] ?? " ")) {
        unsure ??= "it has a '--' that MySQL does not read as a comment";
      }
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }

    // # is a line comment in MySQL only; in Postgres it is an operator.
    if (char === "#" && dialect === "mysql") {
      const end = sql.indexOf("\n", index);
      index = end === -1 ? sql.length : end + 1;
      continue;
    }

    // /* block comment */ — nested in Postgres. MySQL runs the body of a
    // /*! … */ comment as SQL, so that is not a comment we can skip.
    if (char === "/" && next === "*") {
      if (dialect === "mysql" && (sql[index + 2] === "!" || sql[index + 2] === "+")) {
        unsure ??= "it has a MySQL executable comment (/*! … */)";
      }
      let nesting = 1;
      let cursor = index + 2;
      while (cursor < sql.length && nesting > 0) {
        if (sql[cursor] === "/" && sql[cursor + 1] === "*" && dialect === "postgres") {
          nesting += 1;
          cursor += 2;
        } else if (sql[cursor] === "*" && sql[cursor + 1] === "/") {
          nesting -= 1;
          cursor += 2;
        } else {
          cursor += 1;
        }
      }
      if (nesting > 0) unsure ??= "it has an unterminated /* comment";
      index = cursor;
      continue;
    }

    // Quoted strings and identifiers: their content never counts as keywords.
    if (char === "'" || char === '"' || char === "`") {
      let cursor = index + 1;
      let closed = false;
      while (cursor < sql.length) {
        const inner = sql[cursor];
        if (inner === "\\" && backslashEscapes && char === "'") {
          cursor += 2;
          continue;
        }
        if (inner === char) {
          // A doubled quote is an escaped quote, not the end.
          if (sql[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          closed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!closed) unsure ??= `it has an unterminated ${char} quote`;
      current.push({ text: char === "'" ? "'STRING'" : "IDENT", depth });
      index = cursor;
      continue;
    }

    // Postgres dollar quoting: $$ … $$ or $tag$ … $tag$. The body is a
    // function or DO block — code the server runs and this guard cannot read.
    if (char === "$" && dialect === "postgres") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
      if (tag) {
        const delimiter = tag[0];
        const end = sql.indexOf(delimiter, index + delimiter.length);
        if (end === -1) {
          unsure ??= "it has an unterminated $$ block";
          index = sql.length;
        } else {
          index = end + delimiter.length;
        }
        current.push({ text: "$BODY$", depth });
        continue;
      }
    }

    if (char === ";") {
      flush();
      index += 1;
      continue;
    }
    if (char === "(") {
      current.push({ text: "(", depth });
      depth += 1;
      index += 1;
      continue;
    }
    if (char === ")") {
      depth = Math.max(depth - 1, 0);
      current.push({ text: ")", depth });
      index += 1;
      continue;
    }

    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(index));
    if (word) {
      current.push({ text: word[0].toUpperCase(), depth });
      index += word[0].length;
      continue;
    }

    if (!/\s/.test(char)) current.push({ text: char, depth });
    index += 1;
  }

  flush();
  return { statements, unsure };
}

/** Keywords whose presence anywhere in a statement makes it irreversible. */
const ALWAYS: ReadonlyMap<string, string> = new Map([
  ["DROP", "drops a table, index or database"],
  ["TRUNCATE", "empties a table completely"],
  ["ALTER", "changes schema"],
  ["GRANT", "changes access control"],
  ["REVOKE", "changes access control"],
]);

/**
 * Words that, right before UPDATE or DELETE, mean it is not a row-level write:
 * `ON DELETE CASCADE`, `SELECT … FOR UPDATE`, `ON CONFLICT … DO UPDATE`.
 */
const NOT_A_WRITE_BEFORE = new Set(["ON", "FOR", "DO", "KEY", "BEFORE", "AFTER", "OR", "OF", "INSTEAD"]);

/** Why one statement is irreversible, or null when it is ordinary. */
function classify(tokens: Token[]): string | null {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as Token;
    const reason = ALWAYS.get(token.text);
    if (reason) return reason;

    // A DO block or a dynamic EXECUTE runs code this guard cannot read.
    if (token.text === "$BODY$" && tokens.some((t) => t.text === "DO")) {
      return "runs a DO block, which this check cannot read";
    }
    if (token.text === "EXECUTE" && tokens[i + 1]?.text === "'STRING'") {
      return "runs dynamic SQL, which this check cannot read";
    }

    if (token.text !== "DELETE" && token.text !== "UPDATE") continue;
    if (NOT_A_WRITE_BEFORE.has(tokens[i - 1]?.text ?? "")) continue;

    // A WHERE at the same nesting level, before that level closes, filters
    // this statement. One inside a subquery does not.
    let filtered = false;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const later = tokens[j] as Token;
      if (later.depth < token.depth) break;
      if (later.depth === token.depth && later.text === ")") break;
      if (later.depth === token.depth && later.text === "WHERE") {
        filtered = true;
        break;
      }
    }
    if (!filtered) {
      return token.text === "DELETE"
        ? "deletes every row (no WHERE clause)"
        : "rewrites every row (no WHERE clause)";
    }
  }
  return null;
}

/** MongoDB console calls that drop or rewrite whole collections. */
const MONGO_DESTRUCTIVE =
  /\.\s*(drop|dropDatabase|dropIndex|dropIndexes|deleteMany|remove|updateMany|replaceOne|renameCollection|findOneAndDelete|bulkWrite)\s*\(/;

/**
 * Names why the input is worth a second look, or null when it is ordinary.
 *
 * Every statement in the input is checked; the first reason found is
 * returned, prefixed with which statement it is when there are several.
 */
export function destructiveReason(
  input: string,
  dialect: SqlDialect | "mongodb" = "postgres",
): string | null {
  if (dialect === "mongodb") {
    const match = MONGO_DESTRUCTIVE.exec(input);
    return match ? `calls ${match[1]}(), which can remove or rewrite a whole collection` : null;
  }

  // Lex with and without backslash escapes. If the two readings disagree, the
  // engine's reading decides which statements exist, and we cannot know it.
  const strict = lex(input, dialect, false);
  const escaped = lex(input, dialect, true);

  const unsure = strict.unsure ?? escaped.unsure;
  if (unsure) return `may be irreversible: ${unsure}, so it could not be checked`;

  const reasons = (lexed: Lexed): (string | null)[] => lexed.statements.map(classify);
  const a = reasons(strict);
  const b = reasons(escaped);
  if (a.length !== b.length || a.some((reason, i) => reason !== b[i])) {
    return "may be irreversible: a backslash in a string makes it read differently on different engines";
  }

  const index = a.findIndex((reason) => reason !== null);
  if (index === -1) return null;
  const reason = a[index] as string;
  return a.length > 1 ? `${reason} (statement ${index + 1} of ${a.length})` : reason;
}

/** The dialect the guard should lex a service's input as. */
export function dialectOf(serviceType: string): SqlDialect | "mongodb" {
  const type = serviceType.toUpperCase();
  if (type === "MONGODB") return "mongodb";
  if (type === "MYSQL" || type === "MARIADB") return "mysql";
  return "postgres";
}
