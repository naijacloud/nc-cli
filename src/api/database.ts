/**
 * The database console — §3.5.
 *
 * Running a statement is **write-capable** and runs as the service's own database
 * user, so anything that user may do, this may do. There is no read-only mode
 * and no transaction wrapper to hide behind: the guardrails are the caller's
 * job, and they live in `src/commands/db.ts`.
 *
 * Results come back as a rectangle — `columns` names them, each `DbRow.cells`
 * holds one row's values as already-stringified text, with null preserved as a
 * genuine null so an empty string and a NULL stay distinguishable.
 */

import { authed, authedList } from "./transport.js";
import { seg } from "./v1.js";
import type { ServiceType } from "./types.js";

export interface DbQueryResult {
  columns: string[];
  rows: { cells: (string | null)[] }[];
  rowCount: number;
  /** True when the platform capped the result at `maxRows`. */
  truncated: boolean;
  /** Set for statements that return no rows, e.g. "UPDATE 3". */
  message: string | null;
  /** Server-side warnings, e.g. Postgres NOTICE output. */
  notices: string[];
  executionMs: number;
  engine: ServiceType;
}

/**
 * Strips the phantom row the platform appends to every non-empty result.
 *
 * `runDatabaseQuery` returns one extra trailing row containing a single empty
 * cell, and counts it in `rowCount` — so `SELECT id, name … LIMIT 3` comes back
 * as four rows with the last one blank. Verified against a live MySQL service
 * across single-, two- and three-column selects; a result with no rows at all
 * comes back clean (`columns: []`, `rows: []`), so the artifact only ever
 * appears when there is real data above it.
 *
 * Normalised here rather than in the renderer so every consumer — the console,
 * `--json`, and any future MCP tool — sees the same corrected shape.
 *
 * The trailing row is identified by not matching the result's own width. That
 * is exact for multi-column results. For a single-column result the artifact is
 * `[""]`, which a genuine trailing empty string would also be; it is dropped
 * anyway, because a junk row on *every* one-column query is a constant, visible
 * wrong, while the alternative miscounts one pathological query by one row.
 */
function stripPhantomRow(result: DbQueryResult): DbQueryResult {
  const rows = [...result.rows];
  const last = rows[rows.length - 1];

  const isArtifact =
    last !== undefined &&
    last.cells.length === 1 &&
    (last.cells[0] ?? "") === "" &&
    (result.columns.length !== 1 || rows.length > 0);

  if (!isArtifact) return result;

  rows.pop();
  // rowCount tracked the inflated list, so it is re-derived rather than
  // decremented — the two must not be able to disagree.
  return { ...result, rows, rowCount: rows.length };
}

/**
 * Runs one statement.
 *
 * `maxRows` is a cap the platform applies, reporting `truncated` when it bites —
 * a `SELECT *` against a large table therefore returns a page rather than
 * exhausting memory at both ends.
 */
export async function runDatabaseQuery(
  serviceId: string,
  statement: string,
  maxRows?: number,
): Promise<DbQueryResult> {
  const result = await authed<DbQueryResult>("POST", `/services/${seg(serviceId)}/database/query`, {
    body: maxRows === undefined ? { statement } : { statement, maxRows },
  });
  return stripPhantomRow(result);
}

export interface DbObject {
  /** "table", "view", "collection", … — the platform's own word for it. */
  kind: string;
  name: string;
  schema: string | null;
}

export async function listDatabaseObjects(serviceId: string): Promise<DbObject[]> {
  return await authedList<DbObject>(`/services/${seg(serviceId)}/database/objects`);
}

export interface TableStat {
  name: string;
  schema: string | null;
  /** Planner estimate, not a count — cheap, and approximate by design. */
  estimatedRows: number | null;
}

export async function listTableStats(serviceId: string): Promise<TableStat[]> {
  return await authedList<TableStat>(`/services/${seg(serviceId)}/database/table-stats`);
}

export interface DbColumn {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  isPrimaryKey: boolean;
  references: { schema: string | null; table: string; column: string } | null;
}

export interface DbTableSchema {
  name: string;
  schema: string | null;
  columns: DbColumn[];
  primaryKey: string[];
}

export async function getTableColumns(
  serviceId: string,
  table: string,
  schema?: string,
): Promise<DbTableSchema> {
  return await authed<DbTableSchema>(
    "GET",
    `/services/${seg(serviceId)}/database/tables/${seg(table)}/columns`,
    { query: { schema } },
  );
}

/**
 * A dump or table export.
 *
 * The platform writes the file to object storage and hands back a **presigned
 * URL that expires**, so the download is a separate, unauthenticated fetch and
 * `expiresAt` is the useful half of the response.
 */
export interface ExportResult {
  url: string;
  filename: string;
  format: string;
  objectKey: string;
  sizeBytes: number | null;
  expiresAt: string;
}

export type DatabaseExportFormat = "SQL" | "ARCHIVE";
export type TableExportFormat = "CSV" | "JSON" | "SQL";

export async function exportDatabase(
  serviceId: string,
  format?: DatabaseExportFormat,
): Promise<ExportResult> {
  return await authed<ExportResult>("POST", `/services/${seg(serviceId)}/database/export`, {
    body: { format },
  });
}

export async function exportTable(
  serviceId: string,
  table: string,
  format?: TableExportFormat,
  schema?: string,
): Promise<ExportResult> {
  return await authed<ExportResult>(
    "POST",
    `/services/${seg(serviceId)}/database/tables/${seg(table)}/export`,
    { body: { format, schema } },
  );
}
