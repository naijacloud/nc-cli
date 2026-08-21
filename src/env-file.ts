/**
 * Reading a `.env` file into variables the platform will accept.
 *
 * This exists because the alternative is worse in a specific way: a service that
 * needs twelve variables gets created, builds without them, crashes, and only
 * then does anyone go looking for `env set`. Handing the file over at creation
 * time means the first build is the first *correct* build.
 *
 * The format is the informal one every runtime's dotenv loader implements, so
 * this parser matches those rather than inventing a stricter dialect: `export`
 * prefixes, `#` comments, all three quote styles, quoted values that run across
 * lines, and backslash escapes inside double quotes only. Anything it cannot
 * make sense of is *reported and skipped*, never guessed at — a mangled value
 * silently uploaded as a credential is the failure mode worth designing out.
 *
 * Nothing here writes a `.env`. The file is the user's; the CLI reads it.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { EnvVarInput, EnvVarScope } from "./api/index.js";

/**
 * Names the platform accepts. Same rule `env set` enforces, so a file that
 * imports cleanly could also have been typed in one key at a time.
 */
const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A key/value pair read out of the file, with a verdict on its sensitivity. */
export interface EnvFileEntry {
  key: string;
  value: string;
  /** Whether it should be marked secret on the platform. See `looksSecret`. */
  secret: boolean;
}

/** A line that produced no variable, and why — surfaced, never swallowed. */
export interface EnvFileSkip {
  /** The key, when one was readable. Null when the line was not a pair at all. */
  key: string | null;
  line: number;
  reason: string;
}

export interface ParsedEnvFile {
  entries: EnvFileEntry[];
  skipped: EnvFileSkip[];
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Index of the quote that closes a value, or -1 if the file ends first.
 *
 * Double-quoted and backtick-quoted values honour backslash escapes, so `\"`
 * does not end the value. Single-quoted ones do not: in every shell and in POSIX
 * there is no escape inside `'…'`, and pretending otherwise would turn a
 * password ending in a backslash into an unterminated string.
 */
function closingQuote(body: string, quote: string): number {
  const escapes = quote !== "'";

  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (escapes && char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  return -1;
}

/** Resolves the escapes a double-quoted value may contain. */
function unescape(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "\\") {
      result += char;
      continue;
    }

    const next = value[index + 1];
    index += 1;
    switch (next) {
      case "n": result += "\n"; break;
      case "r": result += "\r"; break;
      case "t": result += "\t"; break;
      case "b": result += "\b"; break;
      case "f": result += "\f"; break;
      case "\\": result += "\\"; break;
      case '"': result += '"'; break;
      case "'": result += "'"; break;
      case "`": result += "`"; break;
      // An escape this format does not define is left exactly as written. A
      // Windows path in an unquoted-looking value keeps its backslashes rather
      // than losing every one of them to a rule that was never agreed on.
      default:
        result += next === undefined ? "\\" : `\\${next}`;
        break;
    }
  }
  return result;
}

/**
 * Trims a trailing `#` comment off an unquoted value.
 *
 * Only a `#` at the start or after whitespace opens a comment, so a value like
 * `secret#1` survives intact — that is a real password shape, and eating half of
 * it would be silent corruption.
 */
function stripComment(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "#") continue;
    if (index === 0 || /\s/.test(value[index - 1]!)) return value.slice(0, index);
  }
  return value;
}

/** `KEY=`, `export KEY=`, and the tolerated `KEY:` of some YAML-ish files. */
const PAIR = /^\s*(?:export\s+)?([^\s=:#]+)\s*[=:]\s*([\s\S]*)$/;

/**
 * Parses a `.env` document.
 *
 * Later definitions of a key win, matching how a shell sourcing the file and
 * every mainstream dotenv loader behave — and the duplicate is reported, because
 * a file that sets `DATABASE_URL` twice is usually a merge accident and the
 * value that survives is worth seeing.
 */
export function parseEnvFile(text: string): ParsedEnvFile {
  // A UTF-8 BOM would otherwise become part of the first key's name.
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  const byKey = new Map<string, EnvFileEntry>();
  const order: string[] = [];
  const skipped: EnvFileSkip[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index]!;
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const match = PAIR.exec(line);
    if (!match) {
      skipped.push({ key: null, line: lineNumber, reason: "not a KEY=VALUE line" });
      continue;
    }

    const key = match[1]!;
    const rest = match[2]!;
    const quote = rest[0] === '"' || rest[0] === "'" || rest[0] === "`" ? rest[0] : null;

    let value: string;
    if (quote !== null) {
      let body = rest.slice(1);
      let close = closingQuote(body, quote);

      // A quote left open runs on into the following lines: multi-line values
      // are how private keys and certificates appear in these files.
      while (close === -1 && index + 1 < lines.length) {
        index += 1;
        body += `\n${lines[index]!}`;
        close = closingQuote(body, quote);
      }

      if (close === -1) {
        skipped.push({ key, line: lineNumber, reason: `unterminated ${quote} quote` });
        continue;
      }
      value = body.slice(0, close);
      if (quote !== "'") value = unescape(value);
    } else {
      value = stripComment(rest).trim();
    }

    if (!VALID_KEY.test(key)) {
      skipped.push({
        key,
        line: lineNumber,
        reason: "not a valid variable name (letters, digits, underscore; no leading digit)",
      });
      continue;
    }

    if (byKey.has(key)) {
      skipped.push({ key, line: lineNumber, reason: "duplicate key; the later value is used" });
    } else {
      order.push(key);
    }
    byKey.set(key, { key, value, secret: looksSecret(key, value) });
  }

  return { entries: order.map((key) => byKey.get(key)!), skipped };
}

/* -------------------------------------------------------------------------- */
/* Sensitivity                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Name fragments strong enough to call a variable secret wherever they appear,
 * including welded into a longer word — `PGPASSWORD` has no underscore to split
 * on and is unmistakably a password.
 */
const SECRET_SUBSTRINGS = ["SECRET", "PASSWORD", "PASSWD", "TOKEN", "APIKEY", "PRIVATEKEY"];

/**
 * Fragments that mean something only as a whole word, matched against the
 * underscore-separated parts of a name.
 *
 * `KEY` is the reason this distinction exists: `STRIPE_KEY` is a credential and
 * `MONKEY_MODE` is not, and only word-splitting tells them apart.
 */
const SECRET_WORDS = new Set([
  "KEY", "KEYS", "PASS", "CREDENTIAL", "CREDENTIALS", "PRIVATE",
  "SALT", "CERT", "SIGNATURE", "DSN", "PWD",
]);

/**
 * Prefixes that mean the opposite: frameworks inline these into the client
 * bundle, so the value is served to every visitor and marking it secret would be
 * a false promise about where it ends up.
 */
const PUBLIC_PREFIXES = [
  "NEXT_PUBLIC_", "VITE_", "REACT_APP_", "PUBLIC_",
  "EXPO_PUBLIC_", "NUXT_PUBLIC_", "GATSBY_", "STORYBOOK_",
];

/** A URL carrying `user:password@`, which is a credential whatever it is called. */
const CREDENTIALED_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i;

/**
 * Whether a variable should be marked secret on the platform.
 *
 * A guess, and deliberately a visible one — the flows that use it print what
 * they flagged before writing anything, because being wrong in either direction
 * matters: a missed credential is exposed in listings, and a flagged public URL
 * is merely inconvenient.
 */
export function looksSecret(key: string, value: string): boolean {
  const upper = key.toUpperCase();

  if (PUBLIC_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false;
  if (SECRET_SUBSTRINGS.some((fragment) => upper.includes(fragment))) return true;
  if (upper.split("_").some((word) => SECRET_WORDS.has(word))) return true;

  return CREDENTIALED_URL.test(value.trim());
}

/** Same shape `env ls` masks with, so a value looks identical wherever it is hidden. */
export function maskValue(value: string): string {
  return `******** (${value.length})`;
}

/* -------------------------------------------------------------------------- */
/* Files on disk                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Filenames offered as the source of an import, most likely first.
 *
 * `.env.example` is absent on purpose: it holds placeholders, and uploading
 * `DATABASE_URL=changeme` produces a service that starts and is wrong, which is
 * harder to diagnose than one that does not start at all.
 */
const CANDIDATES = [".env", ".env.local", ".env.production", ".env.prod"];

/** The candidate `.env` files that actually exist in a directory, in order. */
export function findEnvFiles(dir: string): string[] {
  return CANDIDATES.map((name) => join(dir, name)).filter((path) => {
    try {
      return existsSync(path) && statSync(path).isFile();
    } catch {
      return false;
    }
  });
}

/** Reads and parses a `.env`, reporting the path in any failure. */
export function readEnvFile(path: string): ParsedEnvFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${path} (${reason}).`);
  }
  return parseEnvFile(text);
}

/**
 * The scope variables should be written at for a service in a given environment.
 *
 * A preview environment reads UAT — NaijaCloud has no PREVIEW scope — and
 * everything else reads PROD. Deriving it rather than defaulting to PROD is what
 * keeps an import into a preview environment from landing in a scope that
 * environment never consults, which would look like a successful write and
 * behave like a missing variable.
 */
export function scopeForEnvironment(isPreview: boolean): EnvVarScope {
  return isPreview ? "UAT" : "PROD";
}

/** Turns parsed entries into the input `createService` and `setEnvVars` take. */
export function toEnvVarInputs(
  entries: readonly EnvFileEntry[],
  scope: EnvVarScope,
  options: { forceSecret?: boolean } = {},
): EnvVarInput[] {
  return entries.map((entry) => ({
    key: entry.key,
    value: entry.value,
    scope,
    secret: options.forceSecret === true ? true : entry.secret,
  }));
}
