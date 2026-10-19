// Commands that used to report the wrong thing. Each runs the real command
// against a stubbed API and checks what the user is told.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fail, list, run, v1Deploy, v1Service } from "./rest-stub.mjs";

const SERVICE = "11111111-1111-4111-8111-111111111111";

const mutation = { needsRedeploy: false, warnings: [], envVars: [] };

test("env rm of a key the service does not have is an error, not 'removed'", async () => {
  const { envRemove } = await import("../build/commands/env.js");
  const result = await run(
    [
      ["GET", /\/env-vars$/, list([{ key: "REAL", value: "v", scope: "PROD", secret: false, linked: false }])],
      ["DELETE", /\/env-vars\//, mutation],
    ],
    () => envRemove("TYPO", { service: SERVICE, yes: true, json: false }),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /No variable called TYPO/);
  assert.ok(!result.sent.some(({ method }) => method === "DELETE"), "the delete was sent");
});

test("env import --yes still reports the lines it could not read", async () => {
  const { envImport } = await import("../build/commands/env-import.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-env-"));
  const file = path.join(dir, "test.env");
  fs.writeFileSync(file, "GOOD=1\nNOT A VALID LINE\n");
  const result = await run(
    [["PATCH", /\/env-vars$/, mutation]],
    () => envImport(file, { service: SERVICE, env: undefined, scope: "prod", secret: false, yes: true, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.match(result.out, /Imported 1 variable/);
  assert.match(result.err, /Skipped 1 line\(s\):\n  line 2/);
});

test("domains ls shows the CNAME target it tells you to create, not an A record", async () => {
  const { domainsList } = await import("../build/commands/domains.js");
  const domain = {
    id: "d1",
    domain: "app.example.com",
    serviceId: SERVICE,
    status: "PENDING",
    verifiedAt: null,
    lastCheck: null,
    dnsTarget: { cname: "naijacloud.app", aRecord: "192.0.2.1", isApex: false },
  };
  const result = await run(
    [["GET", /\/custom-domains$/, list([domain])]],
    () => domainsList({ service: SERVICE, project: undefined, limit: undefined, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.match(result.out, /naijacloud\.app/);
  assert.doesNotMatch(result.out, /192\.0\.2\.1/);
});

test("whoami --json prints JSON", async () => {
  const { whoami } = await import("../build/commands/auth.js");
  const result = await run(
    [["GET", /^\/me$/, { id: "u1", email: "a@example.com", name: "A", firstName: null, lastName: null, status: "ACTIVE", createdAt: "2026-01-01" }]],
    () => whoami({ json: true }),
  );
  assert.equal(result.error, undefined);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.email, "a@example.com");
  assert.equal(parsed.loggedIn, true);
});

test("redeploy works with a key that may deploy but not read services", async () => {
  const { redeploy } = await import("../build/commands/deployments.js");
  process.env.HOSTING_API_TOKEN = "nc_live_test";
  const result = await run(
    [
      ["GET", /^\/services\//, fail(403, "FORBIDDEN", "This API key does not have the PLATFORM_API scope.")],
      ["POST", /\/deploys$/, { status: 202, body: v1Deploy() }],
    ],
    () => redeploy({ service: SERVICE, wait: false, json: false }),
  );
  process.env.HOSTING_API_TOKEN = "test-token";
  assert.equal(result.error, undefined);
  assert.ok(
    result.sent.some(({ method, path }) => method === "POST" && path === `/services/${SERVICE}/deploys`),
    "the deploy was never triggered",
  );
});

// TGL-1166: on a direct (PUBLIC_A) region the API checks for an A record at
// the node's IP; the CLI told people to CNAME to the proxied app domain, which
// never verifies. The records now come from dnsTarget.records verbatim.
test("domains add prints the records the API asks for, not a guessed CNAME", async () => {
  const { domainsAdd } = await import("../build/commands/domains.js");
  const domain = {
    id: "d1",
    domain: "qa.example.com",
    serviceId: SERVICE,
    status: "PENDING",
    verifiedAt: null,
    lastCheck: null,
    dnsTarget: {
      cname: "naijacloud.app",
      aRecord: "2.24.131.222",
      isApex: false,
      records: [{ type: "A", name: "qa.example.com", value: "2.24.131.222", purpose: "routing" }],
      conflicts: [{ type: "CNAME", name: "qa.example.com", value: "old.host", purpose: "conflict" }],
    },
  };
  const result = await run(
    [["POST", /\/custom-domains$/, { status: 201, body: domain }]],
    () => domainsAdd("qa.example.com", { service: SERVICE, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.match(result.err, /A\s+qa\.example\.com\s+→\s+2\.24\.131\.222/);
  assert.doesNotMatch(result.err, /CNAME\s+qa\.example\.com\s+→\s+naijacloud\.app/);
  assert.match(result.err, /Remove these existing records first[\s\S]*old\.host/);
  const sent = result.sent.find(({ method }) => method === "POST");
  assert.deepEqual(sent.body, { domain: "qa.example.com" });
});

test("domains verify exits non-zero while the domain is still PENDING", async () => {
  const { domainsVerify } = await import("../build/commands/domains.js");
  const pending = {
    id: "11111111-2222-4333-8444-555555555555",
    domain: "qa.example.com",
    serviceId: SERVICE,
    status: "PENDING",
    verifiedAt: null,
    lastCheck: "No A record found yet.",
    dnsTarget: { cname: "naijacloud.app", aRecord: "2.24.131.222", isApex: false, records: null, conflicts: null },
  };
  process.exitCode = undefined;
  const result = await run(
    [["POST", /\/verify$/, pending]],
    () => domainsVerify(pending.id, { service: SERVICE, json: true }),
  );
  assert.equal(result.error, undefined);
  assert.equal(process.exitCode, 1);
  process.exitCode = undefined;
});

// TGL-1172: messages that said the wrong thing.
test("cancel on a finished deployment points at rollback, not 'no rollback'", async () => {
  const { deploymentsCancel } = await import("../build/commands/deployments.js");
  const result = await run(
    [
      ["GET", /^\/deploys\/dep1$/, v1Deploy({ status: "RUNNING" })],
      ["GET", /^\/services\//, v1Service()],
    ],
    () => deploymentsCancel("dep1", { yes: true, json: false }),
  );
  assert.ok(result.error);
  assert.match(result.error.message, /rollback <deployment-id>/);
  assert.doesNotMatch(result.error.message, /no rollback/);
});

test("rollback calls rollbackDeployment", async () => {
  const { rollback } = await import("../build/commands/deployments.js");
  const result = await run(
    [
      ["POST", /^\/deploys\/dep1\/rollback$/, { status: 202, body: v1Deploy({ id: "dep2" }) }],
      ["GET", /^\/deploys\/dep1$/, v1Deploy({ status: "SUPERSEDED", commitSha: "abcdef123456" })],
      ["GET", /^\/services\//, v1Service()],
    ],
    () => rollback("dep1", { yes: true, json: false, wait: false }),
  );
  assert.equal(result.error, undefined);
  assert.ok(result.sent.some(({ method, path }) => method === "POST" && path === "/deploys/dep1/rollback"));
  assert.match(result.out, /dep2 QUEUED/);
});

test("a taken project name says so, instead of the API's generic conflict", async () => {
  const { projectsCreate } = await import("../build/commands/projects.js");
  const result = await run(
    [
      ["GET", /^\/workspaces$/, list([{ id: "t1", name: "Acme", defaultRegion: null }])],
      ["POST", /^\/workspaces\/t1\/projects$/, fail(409, "CONFLICT", "That conflicts with something that already exists.")],
    ],
    () => projectsCreate("shop", { json: false }),
  );
  assert.match(result.error?.message ?? "", /Acme already has a project called 'shop'/);
});

test("db describe of a missing table fails instead of 'no columns'", async () => {
  const { dbDescribe } = await import("../build/commands/db.js");
  const result = await run(
    [
      ["GET", /\/database\/tables\/nope\/columns$/, { name: "nope", schema: "public", primaryKey: [], columns: [] }],
      ["GET", /^\/services\//, v1Service({ name: "db", type: "POSTGRES" })],
      ["GET", /^\/environments\//, { id: "env-1", projectId: "p1", name: "dev", isPreview: false }],
    ],
    () => dbDescribe("nope", { service: SERVICE, json: false, maxRows: undefined, schema: undefined, format: undefined, yes: false }),
  );
  assert.ok(result.error);
  assert.match(result.error.message, /No table 'nope'/);
});
