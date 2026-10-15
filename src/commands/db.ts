/**
 * `naijacloud db` — the database console (§3.5).
 *
 * `runDatabaseQuery` runs as the service's own database user and is fully
 * write-capable: there is no read-only mode to ask for, so a mistyped statement
 * here does what it says. Two things guard against that, and neither is a
 * confirmation on every statement — a console that nags is a console people
 * stop reading:
 *
 *   1. **You always know where you are.** The shell prompt is
 *      `environment/service=#`, so a production database never looks like a
 *      scratch one.
 *   2. **Statements that cannot be undone are confirmed** — DROP, TRUNCATE,
 *      ALTER, GRANT/REVOKE, and an UPDATE or DELETE with no WHERE clause, in
 *      any statement of a multi-statement input (see sql-guard.ts). Ordinary
 *      writes run unchallenged, because they are why the console exists.
 *
 * Non-interactive runs skip the confirmation rather than failing on it. A
 * statement passed as an argument in CI was written deliberately, and demanding
 * a flag there would only break the pipelines that use this properly — `psql -c`
 * makes the same call.
 */

import process from "node:process";

import {
  exportDatabase,
  exportTable,
  getService,
  getTableColumns,
  isKeyValue,
  isQueryable,
  listDatabaseObjects,
  listTableStats,
  runDatabaseQuery,
} from "../api/index.js";
import type {
  DatabaseExportFormat,
  DbQueryResult,
  ExportResult,
  ServiceDetail,
  TableExportFormat,
} from "../api/index.js";
import { formatWhen, printGrid, printJson, printTable } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptLine, promptYesNo, write } from "../terminal.js";
import { requireService } from "./resolve.js";
import { destructiveReason, dialectOf } from "./sql-guard.js";

export { destructiveReason } from "./sql-guard.js";

/* -------------------------------------------------------------------------- */
/* Target                                                                     */
/* -------------------------------------------------------------------------- */

export interface DbOptions {
  service: string | undefined;
  json: boolean;
  maxRows: number | undefined;
  schema: string | undefined;
  format: string | undefined;
  yes: boolean;
}

/**
 * Resolves the service and refuses the engines this cannot drive.
 *
 * Redis and Valkey are not "unsupported" so much as a different shape — they
 * take commands, not statements — so the error points at what would serve
 * instead rather than just declining.
 */
async function target(options: DbOptions, what: string): Promise<ServiceDetail> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    what,
    "db <subcommand> --service <name|id>",
  );
  const service = await getService(serviceId);

  if (isKeyValue(service.type)) {
    throw new Error(
      `${service.name} is ${service.type}, a key-value store — it takes commands, not ` +
        "SQL statements, so the database console does not apply. A `redis` command " +
        "(runCacheCommand) is not implemented yet.",
    );
  }
  if (!isQueryable(service.type)) {
    throw new Error(
      `${service.name} is ${service.type}, not a database. ` +
        `Run \`${programName()} services ls\` to find one.`,
    );
  }
  return service;
}

/* -------------------------------------------------------------------------- */
/* Destructive-statement guard                                                */
/* -------------------------------------------------------------------------- */

/** Returns false when the user declined. Silent for ordinary statements. */
async function allowed(statement: string, service: ServiceDetail, yes: boolean): Promise<boolean> {
  const reason = destructiveReason(statement, dialectOf(service.type));
  if (reason === null || yes || !isInteractive()) return true;

  const where = service.environment?.name ?? "unknown environment";
  write(`\nThis ${reason}.\n`);
  return await promptYesNo(`Run it against ${service.name} (${where})?`, false);
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function report(result: DbQueryResult, json: boolean): void {
  if (json) {
    printJson({
      columns: result.columns,
      rows: result.rows.map((row) => row.cells),
      rowCount: result.rowCount,
      truncated: result.truncated,
      message: result.message,
      notices: result.notices,
      executionMs: result.executionMs,
    });
    return;
  }

  for (const notice of result.notices) write(`NOTICE: ${notice}\n`);

  if (result.columns.length > 0) {
    printGrid(result.columns, result.rows.map((row) => row.cells));
  }

  // A statement with no result set still has an outcome worth printing —
  // "UPDATE 3" is the whole answer for a write.
  const summary =
    result.columns.length > 0
      ? `${result.rowCount} row${result.rowCount === 1 ? "" : "s"}`
      : result.message ?? "ok";

  write(`${summary} · ${result.executionMs} ms\n`);

  if (result.truncated) {
    write(
      `Truncated — more rows matched than were returned. Raise --max-rows, or add a LIMIT.\n`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* db query                                                                   */
/* -------------------------------------------------------------------------- */

export async function dbQuery(statement: string, options: DbOptions): Promise<void> {
  const service = await target(options, "Running a query");

  if (!(await allowed(statement, service, options.yes))) {
    write("Not run.\n");
    return;
  }

  const result = await runDatabaseQuery(service.id, statement, options.maxRows);
  report(result, options.json);
}

/* -------------------------------------------------------------------------- */
/* db shell                                                                   */
/* -------------------------------------------------------------------------- */

const HELP = `Meta-commands
  \\dt          list tables
  \\d <table>   describe a table
  \\q           quit (or Ctrl-C)
  \\?           this message

Statements end with ';' and may span lines.`;

/**
 * A REPL over `runDatabaseQuery`.
 *
 * Statements accumulate until a semicolon, so multi-line SQL pastes work. The
 * psql meta-commands people already have in their fingers (`\dt`, `\d`, `\q`)
 * are mapped onto the same queries the subcommands use, because a console that
 * makes you leave it to list tables is not one.
 */
export async function dbShell(options: DbOptions): Promise<void> {
  const service = await target(options, "Opening a shell");

  if (!isInteractive()) {
    throw new Error(
      `A shell needs an interactive terminal. For a one-off statement use:\n` +
        `  ${programName()} db query "SELECT 1" --service ${service.name}`,
    );
  }

  const where = service.environment?.name ?? "?";
  const prompt = `${where}/${service.name}=# `;
  const continued = `${" ".repeat(Math.max(prompt.length - 3, 0))}-# `;

  write(`${service.name} · ${service.type} · ${where}\n`);
  write(`Type \\? for help, \\q to quit.\n\n`);

  let buffer = "";

  for (;;) {
    let line: string;
    try {
      line = await promptLine(buffer === "" ? prompt : continued);
    } catch {
      // Ctrl-C at the prompt.
      write("\n");
      return;
    }

    const trimmed = line.trim();

    // Meta-commands only make sense on a fresh line; inside a half-typed
    // statement a backslash is the user's problem, not ours.
    if (buffer === "" && trimmed.startsWith("\\")) {
      const [command, ...rest] = trimmed.split(/\s+/);
      if (command === "\\q") return;
      if (command === "\\?") {
        write(`${HELP}\n`);
        continue;
      }
      if (command === "\\dt") {
        await printObjects(service.id, options.json);
        continue;
      }
      if (command === "\\d") {
        const table = rest[0];
        if (!table) {
          write("Usage: \\d <table>\n");
          continue;
        }
        await printColumns(service.id, table, options);
        continue;
      }
      write(`Unknown meta-command '${command}'. \\? for help.\n`);
      continue;
    }

    if (trimmed === "") continue;
    buffer = buffer === "" ? line : `${buffer}\n${line}`;

    // Wait for the terminator, so a pasted multi-line statement runs once.
    if (!buffer.trimEnd().endsWith(";")) continue;

    const statement = buffer.trimEnd().replace(/;$/, "");
    buffer = "";
    if (statement.trim() === "") continue;

    try {
      if (!(await allowed(statement, service, options.yes))) {
        write("Not run.\n");
        continue;
      }
      const result = await runDatabaseQuery(service.id, statement, options.maxRows);
      report(result, false);
    } catch (error) {
      // A bad statement must not end the session — that is the whole point of
      // a REPL over a one-shot command.
      write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    write("\n");
  }
}

/* -------------------------------------------------------------------------- */
/* db tables / describe                                                       */
/* -------------------------------------------------------------------------- */

async function printObjects(serviceId: string, json: boolean): Promise<void> {
  const [objects, stats] = await Promise.all([
    listDatabaseObjects(serviceId),
    // Row estimates are a separate query; a failure there should not cost the
    // listing, so it degrades to a table list without counts.
    listTableStats(serviceId).catch(() => []),
  ]);

  const rowsFor = new Map(
    stats.map((stat) => [`${stat.schema ?? ""}.${stat.name}`, stat.estimatedRows]),
  );

  if (json) {
    printJson({
      count: objects.length,
      objects: objects.map((object) => ({
        ...object,
        estimatedRows: rowsFor.get(`${object.schema ?? ""}.${object.name}`) ?? null,
      })),
    });
    return;
  }

  printTable(
    objects,
    [
      { header: "NAME", value: (object) => object.name },
      { header: "KIND", value: (object) => object.kind },
      { header: "SCHEMA", value: (object) => object.schema },
      {
        header: "~ROWS",
        align: "right",
        value: (object) => {
          const estimate = rowsFor.get(`${object.schema ?? ""}.${object.name}`);
          return estimate === null || estimate === undefined
            ? undefined
            : String(Math.round(estimate));
        },
      },
    ],
    "No tables or collections in this database yet.",
  );
}

export async function dbTables(options: DbOptions): Promise<void> {
  const service = await target(options, "Listing tables");
  await printObjects(service.id, options.json);
}

async function printColumns(
  serviceId: string,
  table: string,
  options: DbOptions,
): Promise<void> {
  const schema = await getTableColumns(serviceId, table, options.schema);

  // The API answers a table that does not exist with an empty column list, not
  // an error. A real table always has columns in practice, so say what it is.
  if (schema.columns.length === 0) {
    throw new Error(
      `No table '${table}'${options.schema ? ` in schema ${options.schema}` : ""}. ` +
        `Run \`${programName()} db tables\` to list them.`,
    );
  }

  if (options.json) {
    printJson(schema);
    return;
  }

  write(`${schema.schema ? `${schema.schema}.` : ""}${schema.name}\n`);
  printTable(
    schema.columns,
    [
      { header: "COLUMN", value: (column) => column.name },
      { header: "TYPE", value: (column) => column.type },
      { header: "NULL", value: (column) => (column.nullable ? "yes" : "no") },
      { header: "KEY", value: (column) => (column.isPrimaryKey ? "PK" : undefined) },
      { header: "DEFAULT", value: (column) => column.default },
      {
        header: "REFERENCES",
        value: (column) =>
          column.references
            ? `${column.references.table}.${column.references.column}`
            : undefined,
      },
    ],
    "This table has no columns.",
  );
}

export async function dbDescribe(table: string, options: DbOptions): Promise<void> {
  const service = await target(options, "Describing a table");
  await printColumns(service.id, table, options);
}

/* -------------------------------------------------------------------------- */
/* db dump / export                                                           */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes: number | null): string | undefined {
  if (bytes === null) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Reports an export.
 *
 * The URL goes to **stdout** and everything else to stderr, so
 * `njc db dump | xargs curl -O` works — the presigned link is the result, and
 * it expires, which is why the expiry is printed beside it.
 */
function reportExport(result: ExportResult, json: boolean): void {
  if (json) {
    printJson(result);
    return;
  }

  process.stdout.write(`${result.url}\n`);
  const size = formatBytes(result.sizeBytes);
  write(
    `${result.filename} · ${result.format}${size ? ` · ${size}` : ""} · ` +
      `link expires ${formatWhen(result.expiresAt)}\n`,
  );
}

/** Validates a format against what the schema accepts, rather than the server. */
function pickFormat<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (raw === undefined) return undefined;
  const wanted = raw.trim().toUpperCase();
  const found = allowed.find((option) => option === wanted);
  if (!found) {
    throw new Error(
      `Unknown format '${raw}'. Use one of: ${allowed.join(", ").toLowerCase()}.`,
    );
  }
  return found;
}

export async function dbDump(options: DbOptions): Promise<void> {
  const service = await target(options, "Exporting a database");
  const format = pickFormat<DatabaseExportFormat>(options.format, ["SQL", "ARCHIVE"]);

  write(`Exporting ${service.name}…\n`);
  reportExport(await exportDatabase(service.id, format), options.json);
}

export async function dbExport(table: string, options: DbOptions): Promise<void> {
  const service = await target(options, "Exporting a table");
  const format = pickFormat<TableExportFormat>(options.format, ["CSV", "JSON", "SQL"]);

  write(`Exporting ${table}…\n`);
  reportExport(
    await exportTable(service.id, table, format, options.schema),
    options.json,
  );
}
