// `env pull [file]`: the dotenv it writes reads back to the same values, only
// what the service's environment receives goes in, and nothing is written
// without a yes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { list, run, v1Service } from "./rest-stub.mjs";

const SERVICE = "11111111-1111-4111-8111-111111111111";

const envVar = (key, value, overrides = {}) => ({ key, value, scope: "ALL", secret: false, linked: false, ...overrides });

function routes(vars, environmentName = "dev") {
  return [
    ["GET", /^\/services\/[^/]+$/, v1Service()],
    ["GET", /^\/environments\/env-1$/, { id: "env-1", projectId: "p1", name: environmentName, isPreview: false }],
    ["GET", /\/env-vars$/, list(vars)],
  ];
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "nc-pull-"));

test("every value survives a write and a read back", async () => {
  const { formatEnvFile, parseEnvFile } = await import("../build/env-file.js");
  const values = {
    PLAIN: "postgres://u:p@db:5432/app",
    EMPTY: "",
    SPACES: "  padded value ",
    HASH: "abc #not-a-comment",
    DOLLAR: "pa$$word",
    SINGLE: "it's here",
    BOTH: `it's "quoted" \\ back`,
    MULTI: "-----BEGIN KEY-----\nabc\ndef\n-----END KEY-----",
    MULTI_QUOTE: "line 1\nit's line 2\ttab",
  };
  const text = formatEnvFile(Object.entries(values).map(([key, value]) => ({ key, value })), ["header"]);
  assert.match(text, /^# header\n/);
  assert.match(text, /^PLAIN=postgres:\/\/u:p@db:5432\/app$/m);
  assert.match(text, /^DOLLAR='pa\$\$word'$/m);
  const parsed = parseEnvFile(text);
  assert.deepEqual(parsed.skipped, []);
  assert.deepEqual(Object.fromEntries(parsed.entries.map((entry) => [entry.key, entry.value])), values);
});

test("a tier scope reaches only the environment of that name", async () => {
  const { scopeApplies } = await import("../build/commands/env.js");
  assert.equal(scopeApplies("ALL", "dev"), true);
  assert.equal(scopeApplies("DEV", "Dev"), true);
  assert.equal(scopeApplies("PROD", "dev"), false);
  assert.equal(scopeApplies("PROD", "staging"), true);
  assert.equal(scopeApplies("UAT", null), true);
});

test("env pull --yes writes the environment's variables, 0600, overwriting the file", async () => {
  const { envPull } = await import("../build/commands/env.js");
  const dir = tmp();
  const file = path.join(dir, ".env.local");
  fs.writeFileSync(file, "OLD=1\n", { mode: 0o644 });
  const result = await run(
    routes([
      envVar("DATABASE_URL", "postgres://u:s3cret@db/app", { secret: true }),
      envVar("PROD_ONLY", "no", { scope: "PROD" }),
      envVar("DEV_ONLY", "yes", { scope: "DEV" }),
    ]),
    () => envPull(file, { service: SERVICE, yes: true, json: false }),
  );
  assert.equal(result.error, undefined, result.error?.message);
  const written = fs.readFileSync(file, "utf8");
  assert.match(written, /^DATABASE_URL=postgres:\/\/u:s3cret@db\/app$/m);
  assert.match(written, /^DEV_ONLY=yes$/m);
  assert.doesNotMatch(written, /PROD_ONLY|OLD=1/);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(result.err, /DATABASE_URL {2}\(secret\)/);
  assert.match(result.err, /already exists and will be overwritten/);
  assert.match(result.err, /Left out 1 variable/);
  assert.doesNotMatch(result.err + result.out, /s3cret/, "a value was printed");
  assert.match(result.out, /Wrote 2 variable\(s\)/);
});

test("env pull without a terminal and without --yes writes nothing", async () => {
  const { envPull } = await import("../build/commands/env.js");
  const file = path.join(tmp(), ".env.local");
  const result = await run(routes([envVar("A", "1")]), () =>
    envPull(file, { service: SERVICE, yes: false, json: false }),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /--yes/);
  assert.equal(fs.existsSync(file), false);
});

test("env pull refuses when a read-only role got every value blanked", async () => {
  const { envPull } = await import("../build/commands/env.js");
  const file = path.join(tmp(), ".env.local");
  const result = await run(routes([envVar("A", ""), envVar("B", "", { secret: true })]), () =>
    envPull(file, { service: SERVICE, yes: true, json: false }),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /came back empty/);
  assert.equal(fs.existsSync(file), false);
});

const hasGit = spawnSync("git", ["--version"]).status === 0;

test("env pull warns when git would commit the file, and not once it is ignored", { skip: !hasGit }, async () => {
  const { envPull } = await import("../build/commands/env.js");
  const dir = tmp();
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: dir }).status, 0);
  const file = path.join(dir, ".env.local");

  const exposed = await run(routes([envVar("A", "1")]), () =>
    envPull(file, { service: SERVICE, yes: true, json: true }),
  );
  assert.equal(exposed.error, undefined, exposed.error?.message);
  assert.match(exposed.err, /not in \.gitignore/);
  const report = JSON.parse(exposed.out);
  assert.equal(report.gitignored, false);
  assert.deepEqual(report.keys, ["A"]);
  assert.equal(JSON.stringify(report).includes('"1"'), false);

  fs.writeFileSync(path.join(dir, ".gitignore"), ".env*.local\n");
  const ignored = await run(routes([envVar("A", "1")]), () =>
    envPull(file, { service: SERVICE, yes: true, json: false }),
  );
  assert.equal(ignored.error, undefined, ignored.error?.message);
  assert.doesNotMatch(ignored.err, /gitignore/);
});
