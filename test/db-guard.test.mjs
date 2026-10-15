// TGL-1168: the irreversible-statement guard looked only at the first keyword
// and tested WHERE against the raw text, so `BEGIN; DROP TABLE t; COMMIT;` and
// `DELETE FROM t -- WHERE id = 1` ran without asking. Every statement is now
// checked, comments and strings are lexed out, and anything the lexer cannot be
// sure of asks.

import { test } from "node:test";
import assert from "node:assert/strict";

const { destructiveReason } = await import("../build/commands/sql-guard.js");

const ASKS = [
  ["BEGIN; DROP TABLE qa_drop_me; COMMIT;", /drops a table.*statement 2 of 3/],
  ["DELETE FROM qa_t -- WHERE id = 1", /deletes every row/],
  ["UPDATE users SET email='x' -- where id=1", /rewrites every row/],
  ["UPDATE users SET email='x' /* WHERE id=1 */", /rewrites every row/],
  ["INSERT INTO t VALUES (1); TRUNCATE t", /empties a table/],
  ["SET search_path = x; DROP SCHEMA public CASCADE", /drops/],
  ["UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)", /rewrites every row/],
  ["WITH gone AS (DELETE FROM t RETURNING *) SELECT count(*) FROM gone", /deletes every row/],
  ["ALTER TABLE t ADD COLUMN c int", /changes schema/],
  ["GRANT ALL ON t TO public", /access control/],
  ["/* note */ drop table t", /drops/],
  ["DO $$ BEGIN EXECUTE 'DROP TABLE t'; END $$", /DO block/],
  ["SELECT 1; DELETE FROM t WHERE id = 1 /* unterminated", /could not be checked/],
  ["SELECT 'it''s; DROP TABLE t", /could not be checked/],
  ["SELECT 'a\\'; DROP TABLE t; --'", /./],
];

const ORDINARY = [
  "SELECT 1",
  "SELECT * FROM t WHERE note = 'DROP TABLE t'",
  "SELECT 'BEGIN; DROP TABLE t; COMMIT;'",
  'SELECT "drop" FROM t',
  "-- DROP TABLE t\nSELECT 1",
  "/* TRUNCATE t */ SELECT 1",
  "DELETE FROM t WHERE id = 1",
  "UPDATE t SET a = 1 WHERE id = 2; UPDATE u SET b = 2 WHERE id = 3",
  "INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET n = 2",
  "SELECT * FROM t FOR UPDATE",
  "CREATE TABLE c (id int REFERENCES p(id) ON DELETE CASCADE ON UPDATE CASCADE)",
  "BEGIN; INSERT INTO t VALUES (1); COMMIT;",
  "SELECT $$DROP TABLE t$$",
];

for (const [sql, reason] of ASKS) {
  test(`asks: ${JSON.stringify(sql)}`, () => {
    const got = destructiveReason(sql, "postgres");
    assert.ok(got, `expected a reason for ${sql}`);
    assert.match(got, reason);
  });
}

for (const sql of ORDINARY) {
  test(`does not ask: ${JSON.stringify(sql)}`, () => {
    assert.equal(destructiveReason(sql, "postgres"), null);
  });
}

test("MySQL: # comments hide a WHERE, and /*! */ runs code", () => {
  assert.match(destructiveReason("DELETE FROM t # WHERE id = 1", "mysql"), /deletes every row/);
  assert.match(destructiveReason("SELECT 1 /*!50000 , (DROP TABLE t) */", "mysql"), /executable comment/);
  assert.equal(destructiveReason("DELETE FROM t WHERE id = 1 # tidy", "mysql"), null);
});

test("MongoDB: collection-wide calls ask", () => {
  assert.match(destructiveReason("db.users.drop()", "mongodb"), /drop/);
  assert.match(destructiveReason("db.users.deleteMany({})", "mongodb"), /deleteMany/);
  assert.equal(destructiveReason("db.users.find({})", "mongodb"), null);
});
