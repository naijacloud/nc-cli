// Commands that used to report the wrong thing. Each runs the real command
// against a stubbed API and checks what the user is told.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVICE = "11111111-1111-4111-8111-111111111111";

/** Runs `fn` with fetch answered by `answer(query)`, capturing stdout and stderr. */
async function run(answer, fn) {
  const realFetch = globalThis.fetch;
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const out = [];
  const err = [];
  const sent = [];
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    sent.push({ query, variables });
    return Response.json({ data: answer(query, variables) });
  };
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = realFetch;
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { out: out.join(""), err: err.join(""), sent, error };
}

const page = (items) => ({ items, pageInfo: { hasNextPage: false } });
const mutation = { needsRedeploy: false, warnings: [], envVars: [] };

test("env rm of a key the service does not have is an error, not 'removed'", async () => {
  const { envRemove } = await import("../build/commands/env.js");
  const result = await run(
    (query) =>
      /getServiceEnvVars/.test(query)
        ? { getServiceEnvVars: page([{ key: "REAL", value: "v", scope: "PROD", secret: false, linked: false }]) }
        : { deleteEnvVar: mutation },
    () => envRemove("TYPO", { service: SERVICE, yes: true, json: false }),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /No variable called TYPO/);
  assert.ok(!result.sent.some(({ query }) => /deleteEnvVar/.test(query)), "deleteEnvVar was sent");
});

test("env import --yes still reports the lines it could not read", async () => {
  const { envImport } = await import("../build/commands/env-import.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-env-"));
  const file = path.join(dir, "test.env");
  fs.writeFileSync(file, "GOOD=1\nNOT A VALID LINE\n");
  const result = await run(
    () => ({ setEnvVars: mutation }),
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
    () => ({ getCustomDomains: page([domain]) }),
    () => domainsList({ service: SERVICE, project: undefined, limit: undefined, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.match(result.out, /naijacloud\.app/);
  assert.doesNotMatch(result.out, /192\.0\.2\.1/);
});

test("whoami --json prints JSON", async () => {
  const { whoami } = await import("../build/commands/auth.js");
  const result = await run(
    () => ({ getMe: { id: "u1", email: "a@example.com", name: "A", firstName: null, lastName: null, status: "ACTIVE", createdAt: "2026-01-01" } }),
    () => whoami({ json: true }),
  );
  assert.equal(result.error, undefined);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.email, "a@example.com");
  assert.equal(parsed.loggedIn, true);
});

test("redeploy works with a key that may deploy but not read services", async () => {
  const { redeploy } = await import("../build/commands/deployments.js");
  const realFetch = globalThis.fetch;
  const sent = [];
  process.env.HOSTING_API_TOKEN = "nc_live_test";
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    sent.push(query);
    if (/getService/.test(query)) {
      return Response.json({
        errors: [{ message: "This API key does not have the PLATFORM_API scope.", extensions: { code: "FORBIDDEN" } }],
        data: null,
      });
    }
    return Response.json({ data: { triggerDeploy: { id: "dep1", serviceId: SERVICE, status: "QUEUED" } } });
  };
  const realErr = process.stderr.write;
  process.stderr.write = () => true;
  try {
    await redeploy({ service: SERVICE, wait: false, json: false });
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realErr;
  }
  assert.ok(sent.some((query) => /triggerDeploy/.test(query)), "triggerDeploy was never sent");
});
