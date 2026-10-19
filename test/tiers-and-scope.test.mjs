// TGL-782: every `launch` and `services create` made a paid service, `--tier`
// offered a "standard" size that is not a product, and `env set` wrote PROD in
// a dev environment, where the app never sees it.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fail, list, run, v1Service } from "./rest-stub.mjs";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const FREE_TAKEN =
  "You already have a free app. Each account gets one free web service or cron job — choose a paid size for this one, or resize the free one to a paid size first.";

const mutation = { needsRedeploy: false, warnings: [], envVars: [] };
const CATALOG = {
  serviceTiers: [
      ["FREE", "Free", 256, 250, 0],
      ["STARTER", "Starter", 512, 500, 350000],
      ["STANDARD", "Pro", 1024, 1000, 700000],
      ["PRO", "Pro Max", 2048, 2000, 1400000],
    ].map(([tier, label, memoryMb, cpuMillicores, priceKobo]) => ({
      family: "compute",
      tier,
      label,
      memoryMb,
      cpuMillicores,
      storageMb: null,
      priceKobo,
      currency: "NGN",
    })),
};
const CREATED = { status: 201, body: v1Service({ id: SERVICE, environmentId: ENVIRONMENT }) };
const CREATE = ["POST", /^\/environments\/[^/]+\/services$/];
const PRICING = ["GET", /^\/pricing$/, CATALOG];
const NO_DEPLOYS = ["GET", /\/deploys$/, list([])];
const creates = (sent) => sent.filter(({ method, path }) => method === CREATE[0] && CREATE[1].test(path));

/* ---------------------------------------------------------------- tiers -- */

test("--tier maps the product names onto the API's enum", async () => {
  const { parseTier } = await import("../build/tiers.js");
  assert.equal(parseTier("free", "compute"), "FREE");
  assert.equal(parseTier("starter", "compute"), "STARTER");
  assert.equal(parseTier("pro", "compute"), "STANDARD");
  assert.equal(parseTier("pro-max", "compute"), "PRO");
  assert.equal(parseTier("Pro Max", "compute"), "PRO");
  assert.equal(parseTier("PRO_MAX", "compute"), "PRO");
  assert.equal(parseTier("dev", "data"), "STARTER");
  assert.equal(parseTier("pro", "data"), "STANDARD");
});

test("'standard' is not a size, and the error lists only real ones", async () => {
  const { parseTier } = await import("../build/tiers.js");
  assert.throws(() => parseTier("standard", "compute"), (error) => {
    assert.match(error.message, /must be free, starter, pro or pro-max/);
    assert.doesNotMatch(error.message.replace("'standard'", ""), /standard/i);
    return true;
  });
  assert.throws(() => parseTier("starter", "data"), /free, dev, pro or pro-max/);
});

test("no label shown to a user is the API's raw value", async () => {
  const { tierLabel } = await import("../build/tiers.js");
  for (const tier of ["FREE", "STARTER", "STANDARD", "PRO"]) {
    assert.doesNotMatch(tierLabel(tier, "compute"), /standard/i);
    assert.doesNotMatch(tierLabel(tier, "data"), /standard/i);
  }
  assert.equal(tierLabel("STANDARD", "compute"), "Pro");
  assert.equal(tierLabel("PRO", "compute"), "Pro Max");
  assert.equal(tierLabel("STARTER", "data"), "Dev");
});

test("an app is Free unless a size is named", async () => {
  const { appTierOrFree } = await import("../build/tiers.js");
  assert.equal(appTierOrFree(undefined), "FREE");
  assert.equal(appTierOrFree("pro"), "STANDARD");
});

test("services create sends tier FREE when no --tier is given", async () => {
  const { servicesCreate } = await import("../build/commands/services.js");
  const result = await run(
    [[...CREATE, CREATED], NO_DEPLOYS, PRICING],
    () => servicesCreate("api", createOptions({ tier: undefined })),
  );
  const [create] = creates(result.sent);
  assert.ok(create, "the create was not sent");
  assert.equal(create.body.tier, "FREE");
  assert.match(result.err, /Size: Free/);
});

test("services create --tier pro sends STANDARD and shows the catalog price", async () => {
  const { servicesCreate } = await import("../build/commands/services.js");
  const result = await run(
    [PRICING, [...CREATE, CREATED], NO_DEPLOYS],
    () => servicesCreate("api", createOptions({ tier: "pro" })),
  );
  const [create] = creates(result.sent);
  assert.equal(create.body.tier, "STANDARD");
  assert.match(result.err, /Size: Pro · ₦7,000\/month/);
});

test("services create never falls back to a paid size when the free app is taken", async () => {
  const { servicesCreate } = await import("../build/commands/services.js");
  const result = await run(
    [PRICING, [...CREATE, fail(400, "BAD_REQUEST", FREE_TAKEN)]],
    () => servicesCreate("api", createOptions({ tier: undefined })),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /Nothing was created/);
  assert.match(result.error.message, /--tier starter .*₦3,500\/month/);
  assert.match(result.error.message, /--tier pro-max/);
  assert.equal(creates(result.sent).length, 1, "retried the create on its own");
});

test("launch's create asks for a size when the free app is taken, then retries at it", async () => {
  const { createPreferringFree } = await import("../build/commands/services.js");
  let asked = 0;
  const result = await run(
    [
      [...CREATE, ({ body }) => (body.tier === "FREE" ? fail(400, "BAD_REQUEST", FREE_TAKEN) : CREATED)],
      NO_DEPLOYS,
      PRICING,
    ],
    () =>
      createPreferringFree(
        { environmentId: ENVIRONMENT, name: "api", type: "WEB", sourceType: "GITHUB_APP", repoFullName: "o/r", tier: "FREE" },
        { wait: false, json: false, envSource: null, envCount: 0 },
        async (refusal) => {
          asked += 1;
          assert.match(refusal.message, /already have a free app/);
          return "STARTER";
        },
      ),
  );
  assert.equal(result.error, undefined);
  assert.equal(asked, 1);
  const tiers = creates(result.sent).map(({ body }) => body.tier);
  assert.deepEqual(tiers, ["FREE", "STARTER"]);
});

test("a refusal that is not about the free slot is not turned into a size question", async () => {
  const { createPreferringFree } = await import("../build/commands/services.js");
  let asked = 0;
  const result = await run(
    [[...CREATE, fail(400, "BAD_REQUEST", "Repository not found")]],
    () =>
      createPreferringFree(
        { environmentId: ENVIRONMENT, name: "api", type: "WEB", sourceType: "GITHUB_APP", repoFullName: "o/r", tier: "FREE" },
        { wait: false, json: false, envSource: null, envCount: 0 },
        async () => {
          asked += 1;
          return "STARTER";
        },
      ),
  );
  assert.match(result.error.message, /Repository not found/);
  assert.equal(asked, 0);
});

function createOptions(overrides) {
  return {
    env: ENVIRONMENT,
    repo: "o/r",
    branch: undefined,
    type: undefined,
    build: undefined,
    start: undefined,
    port: undefined,
    rootDir: undefined,
    runtimeVersion: undefined,
    schedule: undefined,
    healthCheck: undefined,
    region: undefined,
    tier: undefined,
    envFile: undefined,
    noEnvFile: true,
    scope: undefined,
    secret: false,
    wait: false,
    json: false,
    ...overrides,
  };
}

/* ---------------------------------------------------------------- scope -- */

test("the scope follows the environment's name, the way deploys filter it", async () => {
  const { scopeForEnvironment } = await import("../build/env-file.js");
  assert.equal(scopeForEnvironment({ name: "dev", isPreview: false }), "DEV");
  assert.equal(scopeForEnvironment({ name: "Prod", isPreview: false }), "PROD");
  assert.equal(scopeForEnvironment({ name: " uat ", isPreview: false }), "UAT");
  assert.equal(scopeForEnvironment({ name: "staging", isPreview: true }), "UAT");
  assert.equal(scopeForEnvironment({ name: "staging", isPreview: false }), "PROD");
  assert.equal(scopeForEnvironment({ name: null, isPreview: false }), "PROD");
});

/** The two reads that tell the CLI which environment a service lives in. */
const serviceIn = (environment) => [
  ["GET", new RegExp(`^/services/${SERVICE}$`), v1Service({ id: SERVICE, environmentId: ENVIRONMENT })],
  ["GET", new RegExp(`^/environments/${ENVIRONMENT}$`), { id: ENVIRONMENT, projectId: "p1", name: environment, isPreview: false }],
];
const SET_VARS = ["PATCH", /\/env-vars$/, mutation];

test("env set in a dev environment writes DEV, not PROD", async () => {
  const { envSet } = await import("../build/commands/env.js");
  const result = await run(
    [...serviceIn("dev"), SET_VARS],
    () => envSet("FEATURE_FLAG", "on", { service: SERVICE, scope: undefined, secret: false, json: false }),
  );
  assert.equal(result.error, undefined);
  const write = result.sent.find(({ method }) => method === "PATCH");
  assert.equal(write.body.envVars[0].scope, "DEV", JSON.stringify(write.body));
  assert.match(result.out, /FEATURE_FLAG set \(DEV, from environment dev\)/);
});

test("env set --scope still overrides, without reading the service", async () => {
  const { envSet } = await import("../build/commands/env.js");
  const result = await run(
    [SET_VARS],
    () => envSet("FEATURE_FLAG", "on", { service: SERVICE, scope: "prod", secret: false, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.ok(!result.sent.some(({ method, path }) => method === "GET" && path.startsWith("/services/")), "read the service anyway");
  assert.match(result.out, /FEATURE_FLAG set \(PROD\)\n/);
});

test("env import without --scope or --env derives the scope from the service", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { envImport } = await import("../build/commands/env-import.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-env-"));
  const file = path.join(dir, "test.env");
  fs.writeFileSync(file, "GOOD=1\n");
  const result = await run(
    [...serviceIn("dev"), SET_VARS],
    () => envImport(file, { service: SERVICE, env: undefined, scope: undefined, secret: false, yes: true, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.match(result.out, /Imported 1 variable from .* \(DEV\)/);
});

/* --------------------------------------------------------------- cancel -- */

test("backing out of a prompt is recognised as a cancel, not a failure", async () => {
  const { CancelledError, isCancelled } = await import("../build/terminal.js");
  assert.equal(isCancelled(new CancelledError()), true);
  assert.equal(isCancelled(new Error("HTTP 500")), false);
});

test("the repo picker's filter matches name or hint, ignoring case", async () => {
  const { matchesFilter } = await import("../build/interactive.js");
  const repo = { label: "acme/Web-App", hint: "private · main", value: 1 };
  assert.equal(matchesFilter(repo, ""), true);
  assert.equal(matchesFilter(repo, "web"), true);
  assert.equal(matchesFilter(repo, "PRIVATE"), true);
  assert.equal(matchesFilter(repo, "api"), false);
});
