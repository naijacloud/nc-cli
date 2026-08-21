/**
 * Rendering for the resource commands: one aligned table for humans, one JSON
 * document for scripts.
 *
 * Both go to **stdout**, because both are the command's result — unlike
 * terminal.ts, whose prompts and progress are stderr so that `--json` output
 * stays pipeable. The split is what makes `njc services ls --json | jq` and
 * `njc services ls` the same command.
 *
 * Every table here is padded, never truncated. A column that overflows the
 * terminal wraps, which is ugly; a column that silently drops half a service id
 * is worse, because the id is the thing the next command needs.
 */

import process from "node:process";

export interface Column<T> {
  header: string;
  /** Cell text. Empty and null-ish values render as `-` so a row never collapses. */
  value: (row: T) => string | null | undefined;
  /** Right-align, for counts and sizes. */
  align?: "right";
}

/** Placeholder for an absent value, so columns stay countable by eye. */
const EMPTY = "-";

function cell(text: string | null | undefined): string {
  const value = (text ?? "").trim();
  return value === "" ? EMPTY : value;
}

/**
 * Writes an aligned table, or a short note when there is nothing to show.
 *
 * `empty` is a full sentence rather than a bare "none": an empty list usually
 * means the caller scoped the query wrong, and the message is the only place to
 * say what would have widened it.
 *
 * `indent` prefixes every line, for a table nested under a heading. It is a
 * parameter rather than something a caller can fake with leading spaces in a
 * cell, because cells are trimmed before they are measured — padding them by
 * hand misaligns the column it was meant to shift.
 */
export function printTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  empty: string,
  indent = "",
): void {
  if (rows.length === 0) {
    process.stderr.write(`${indent}${empty}\n`);
    return;
  }
  process.stdout.write(renderTable(rows, columns, indent));
}

/**
 * The same table as a string, for callers that are not writing a *result*.
 *
 * A table shown inside a prompt — "here is what I am about to import, confirm?"
 * — is progress, and progress belongs on stderr with the rest of the questions.
 * Returning the text rather than adding a stream argument keeps the choice of
 * destination at the call site, where the answer is obvious.
 */
export function renderTable<T>(
  rows: readonly T[],
  columns: readonly Column<T>[],
  indent = "",
): string {
  if (rows.length === 0) return "";

  const body = rows.map((row) => columns.map((column) => cell(column.value(row))));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...body.map((line) => line[index]!.length)),
  );

  const render = (cells: string[]): string =>
    cells
      .map((text, index) => {
        const width = widths[index]!;
        return columns[index]!.align === "right" ? text.padStart(width) : text.padEnd(width);
      })
      .join("  ")
      // Trailing padding on the last column is invisible but shows up in a diff
      // or a `| cat -A`, so trim it off.
      .trimEnd();

  const lines = [render(columns.map((column) => column.header)), ...body.map(render)];
  return `${lines.map((line) => `${indent}${line}`).join("\n")}\n`;
}

/**
 * Writes a table whose columns are only known at runtime — a query result.
 *
 * `printTable` types its columns against the row shape, which a `SELECT` cannot
 * do. The other difference is NULL: a database distinguishes it from the empty
 * string, so it renders as a visible `NULL` rather than the `-` used for a
 * field that simply has no value.
 */
export function printGrid(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): void {
  const text = rows.map((row) => columns.map((_, index) => row[index] ?? "NULL"));

  const widths = columns.map((header, index) =>
    Math.max(header.length, ...text.map((row) => row[index]!.length), 0),
  );

  const render = (cells: readonly string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ").trimEnd();

  const lines = [
    render(columns),
    // A rule under the header: query output is often tall, and the header is
    // the only thing telling you what column four was.
    widths.map((width) => "─".repeat(width)).join("  "),
    ...text.map(render),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

/** The machine-readable half of every command. */
export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Key/value block for the `show` commands, aligned on the colon.
 *
 * Entries whose value is undefined are dropped rather than rendered as `-`:
 * a detail view lists what applies to *this* resource, and a static site has no
 * branch at all rather than an unknown one.
 */
export type DetailEntry = readonly [string, string | null | undefined];

export function printDetail(entries: readonly DetailEntry[]): void {
  const shown = entries.filter(([, value]) => value !== undefined);
  const width = Math.max(...shown.map(([label]) => label.length));
  const lines = shown.map(([label, value]) => `${`${label}:`.padEnd(width + 2)}${cell(value)}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Compact absolute timestamp — `2026-08-07 14:03`.
 *
 * Local time, no seconds, no timezone suffix. A deploy list is scanned for
 * "which one was that", and an ISO-8601 string in a column is 25 characters of
 * mostly-punctuation to answer it.
 */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return EMPTY;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;

  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** First line of a commit message, for a table cell. */
export function firstLine(text: string | null | undefined, max = 48): string {
  if (!text) return EMPTY;
  const line = text.split("\n")[0]!.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Short commit sha, the length every git UI settled on. */
export function shortSha(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : EMPTY;
}
