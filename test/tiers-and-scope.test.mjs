// TGL-782: every `launch` and `services create` made a paid service, `--tier`
// offered a "standard" size that is not a product, and `env set` wrote PROD in
// a dev environment, where the app never sees it.

import { test } from "node:test";
import assert from "node:assert/strict";

const SERVICE = "11111111-1111-4111-8111-111111111111";
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";
const FREE_TAKEN =
  "You already have a free app. Each account gets one free web service or cron job — choose a paid size for this one, or resize the free one to a paid size first.";

/** Runs `fn` with fetch answered by `answer(query, variables)`, capturing output. */
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
    const reply = answer(query, variables);
    if (reply instanceof Error) return Response.json({ data: null, errors: [{ message: reply.message }] });
    return Response.json({ data: reply });
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
const CATALOG = {
  getPricingCatalog: {
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
  },
};
const CREATED = {
  createService: { id: SERVICE, name: "api", type: "WEB", status: "ACTIVE", health: null, url: null, branch: "main", repoFullName: "o/r", isStatic: false },
};

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
    (query) => {
      if (/createService/.test(query)) return CREATED;
      if (/getDeployments|deployments/i.test(query)) return { getServiceDeployments: page([]), getDeployments: page([]) };
      return {};
    },
    () => servicesCreate("api", createOptions({ tier: undefined })),
  );
  const create = result.sent.find(({ query }) => /createService/.test(query));
  assert.ok(create, "createService was not sent");
  assert.equal(create.variables.input.tier, "FREE");
  assert.match(result.err, /Size: Free/);
});

test("services create --tier pro sends STANDARD and shows the catalog price", async () => {
  const { servicesCreate } = await import("../build/commands/services.js");
  const result = await run(
    (query) => {
      if (/getPricingCatalog/.test(query)) return CATALOG;
      if (/createService/.test(query)) return CREATED;
      return { getServiceDeployments: page([]), getDeployments: page([]) };
    },
    () => servicesCreate("api", createOptions({ tier: "pro" })),
  );
  const create = result.sent.find(({ query }) => /createService/.test(query));
  assert.equal(create.variables.input.tier, "STANDARD");
  assert.match(result.err, /Size: Pro · ₦7,000\/month/);
});

test("services create never falls back to a paid size when the free app is taken", async () => {
  const { servicesCreate } = await import("../build/commands/services.js");
  const result = await run(
    (query) => {
      if (/getPricingCatalog/.test(query)) return CATALOG;
      if (/createService/.test(query)) return new Error(FREE_TAKEN);
      return {};
    },
    () => servicesCreate("api", createOptions({ tier: undefined })),
  );
  assert.ok(result.error, "expected an error");
  assert.match(result.error.message, /Nothing was created/);
  assert.match(result.error.message, /--tier starter .*₦3,500\/month/);
  assert.match(result.error.message, /--tier pro-max/);
  const creates = result.sent.filter(({ query }) => /createService/.test(query));
  assert.equal(creates.length, 1, "retried the create on its own");
});

test("launch's create asks for a size when the free app is taken, then retries at it", async () => {
  const { createPreferringFree } = await import("../build/commands/services.js");
  let asked = 0;
  const result = await run(
    (query, variables) => {
      if (/createService/.test(query)) {
        return variables.input.tier === "FREE" ? new Error(FREE_TAKEN) : CREATED;
      }
      return { getServiceDeployments: page([]), getDeployments: page([]) };
    },
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
  const tiers = result.sent
    .filter(({ query }) => /createService/.test(query))
    .map(({ variables }) => variables.input.tier);
  assert.deepEqual(tiers, ["FREE", "STARTER"]);
});

test("a refusal that is not about the free slot is not turned into a size question", async () => {
  const { createPreferringFree } = await import("../build/commands/services.js");
  let asked = 0;
  const result = await run(
    () => new Error("Repository not found"),
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

const serviceIn = (environment) => ({
  getService: {
    id: SERVICE,
    name: "api",
    type: "WEB",
    status: "ACTIVE",
    health: null,
    url: null,
    branch: "main",
    repoFullName: "o/r",
    isStatic: false,
    isPreview: false,
    environmentId: ENVIRONMENT,
    environment: { id: ENVIRONMENT, name: environment },
    sourceType: "GITHUB_APP",
    rootDir: null,
    buildCommand: null,
    startCommand: null,
  },
});

test("env set in a dev environment writes DEV, not PROD", async () => {
  const { envSet } = await import("../build/commands/env.js");
  const result = await run(
    (query) => (/GetService/.test(query) ? serviceIn("dev") : { setEnvVars: mutation }),
    () => envSet("FEATURE_FLAG", "on", { service: SERVICE, scope: undefined, secret: false, json: false }),
  );
  assert.equal(result.error, undefined);
  const write = result.sent.find(({ query }) => /setEnvVars/.test(query));
  assert.equal(JSON.stringify(write.variables).includes('"DEV"'), true, JSON.stringify(write.variables));
  assert.match(result.out, /FEATURE_FLAG set \(DEV, from environment dev\)/);
});

test("env set --scope still overrides, without reading the service", async () => {
  const { envSet } = await import("../build/commands/env.js");
  const result = await run(
    () => ({ setEnvVars: mutation }),
    () => envSet("FEATURE_FLAG", "on", { service: SERVICE, scope: "prod", secret: false, json: false }),
  );
  assert.equal(result.error, undefined);
  assert.ok(!result.sent.some(({ query }) => /GetService/.test(query)), "read the service anyway");
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
    (query) => (/GetService/.test(query) ? serviceIn("dev") : { setEnvVars: mutation }),
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
