// `db query` against the `/v1` result shape.
//
// `POST /v1/services/:id/database/query` answers `rows` as one array per row
// (`[["1"]]`). The CLI still read the GraphQL shape (`[{ cells: ["1"] }]`), so
// every query that returned a row failed with "Cannot read properties of
// undefined (reading 'length')" before printing anything, in both the grid and
// --json. These run the real command against the shape the API sends.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { run, v1Service } from "./rest-stub.mjs";

const SERVICE = "11111111-1111-4111-8111-111111111111";

const options = (overrides = {}) => ({
  service: SERVICE,
  json: false,
  maxRows: undefined,
  schema: undefined,
  format: undefined,
  yes: false,
  ...overrides,
});

/** A `/v1` V1QueryResult, exactly as the control plane sends it. */
const v1Result = (overrides = {}) => ({
  engine: "POSTGRES",
  columns: ["?column?"],
  rows: [["1"]],
  rowCount: 1,
  truncated: false,
  message: null,
  notices: [],
  executionMs: 12,
  ...overrides,
});

const routes = (answer) => [
  ["POST", /\/database\/query$/, answer],
  ["GET", /^\/services\//, v1Service({ name: "neo-store-db", type: "POSTGRES" })],
  ["GET", /^\/environments\//, { id: "env-1", projectId: "p1", name: "production", isPreview: false }],
];

test("the OpenAPI contract sends rows as arrays, which is what these tests stub", () => {
  const openapi = JSON.parse(
    fs.readFileSync(fileURLToPath(new URL("./fixtures/openapi.json", import.meta.url)), "utf8"),
  );
  const rows = openapi.components.schemas.V1QueryResult.properties.rows;
  assert.equal(rows.type, "array");
  assert.equal(rows.items.type, "array");
});

test("db query prints the grid for a /v1 result instead of crashing", async () => {
  const { dbQuery } = await import("../build/commands/db.js");
  const result = await run(routes(v1Result()), () => dbQuery("select 1", options()));
  assert.equal(result.error, undefined, result.error?.stack);
  assert.match(result.out, /\?column\?/);
  assert.match(result.out, /^1\s*$/m);
  assert.match(result.err, /1 row · 12 ms/); // the summary is progress, on stderr
  const sent = result.sent.find(({ method }) => method === "POST");
  assert.deepEqual(sent.body, { statement: "select 1" });
});

test("db query --json emits rows as arrays, with NULL and '' kept apart", async () => {
  const { dbQuery } = await import("../build/commands/db.js");
  const result = await run(
    routes(v1Result({ columns: ["now", "n", "e"], rows: [["2026-11-21T14:12:02Z", null, ""]] })),
    () => dbQuery("select now(), null as n, '' as e", options({ json: true })),
  );
  assert.equal(result.error, undefined, result.error?.stack);
  const json = JSON.parse(result.out);
  assert.deepEqual(json.columns, ["now", "n", "e"]);
  assert.deepEqual(json.rows, [["2026-11-21T14:12:02Z", null, ""]]);
  assert.equal(json.rowCount, 1);
});

test("db query drops the trailing one-empty-cell row MySQL results carry", async () => {
  const { dbQuery } = await import("../build/commands/db.js");
  const result = await run(
    routes(v1Result({ engine: "MYSQL", columns: ["id", "name"], rows: [["1", "a"], ["2", "b"], [""]], rowCount: 3 })),
    () => dbQuery("select id, name from t", options({ json: true })),
  );
  assert.equal(result.error, undefined, result.error?.stack);
  const json = JSON.parse(result.out);
  assert.deepEqual(json.rows, [["1", "a"], ["2", "b"]]);
  assert.equal(json.rowCount, 2);
});

test("db query of a write prints the server's message", async () => {
  const { dbQuery } = await import("../build/commands/db.js");
  const result = await run(
    routes(v1Result({ columns: [], rows: [], rowCount: 0, message: "UPDATE 3" })),
    () => dbQuery("update t set x = 1 where id < 4", options({ yes: true })),
  );
  assert.equal(result.error, undefined, result.error?.stack);
  assert.match(result.err, /UPDATE 3 · 12 ms/);
});
