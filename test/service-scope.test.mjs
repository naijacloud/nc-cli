// --project (and --env) narrow which service a --service name means, so
// `env set KEY --service functions-runtime --project shop` works when every
// project with functions has a service called functions-runtime.

import { test } from "node:test";
import assert from "node:assert/strict";

import { list, run, v1Service } from "./rest-stub.mjs";

const { resolveServiceId } = await import("../build/commands/resolve.js");
const { envSet } = await import("../build/commands/env.js");

const SHOP = "22222222-2222-4222-8222-222222222222";
const PROD_RT = "33333333-3333-4333-8333-333333333333";
const DEV_RT = "44444444-4444-4444-8444-444444444444";

const tree = (environments) => [
  ["GET", /^\/projects\/[^/]+$/, { id: SHOP, workspaceId: "t1", name: "shop", displayName: null, description: null, defaultRegion: null, createdAt: "x", updatedAt: "x" }],
  ["GET", /^\/projects\/[^/]+\/environments$/, list(environments.map(([id, name]) => ({ id, projectId: SHOP, name, isPreview: false })))],
  ...environments.map(([id, , services]) => ["GET", new RegExp(`^/environments/${id}/services$`), list(services)]),
];

const runtime = (id) => v1Service({ id, name: "functions-runtime", functionsRuntime: true });
const otherProjects = [
  "GET",
  /^\/services$/,
  list([
    { id: PROD_RT, name: "functions-runtime", projectName: "shop", type: "WEB" },
    { id: "55555555-5555-4555-8555-555555555555", name: "functions-runtime", projectName: "blog", type: "WEB" },
  ]),
];

async function resolve(reference, scope, routes) {
  let id;
  const result = await run(routes, async () => {
    id = await resolveServiceId(reference, scope);
  });
  return { id, error: result.error, sent: result.sent };
}

test("--project finds the service in that project only", async () => {
  const { id, error } = await resolve("functions-runtime", { project: SHOP }, [
    otherProjects,
    ...tree([["e1", "prod", [v1Service(), runtime(PROD_RT)]]]),
  ]);
  assert.equal(error, undefined);
  assert.equal(id, PROD_RT);
});

test("--project with the name in two environments lists the ids; --env picks one", async () => {
  const routes = tree([
    ["e1", "prod", [runtime(PROD_RT)]],
    ["e2", "dev", [runtime(DEV_RT)]],
  ]);
  const both = await resolve("functions-runtime", { project: SHOP }, routes);
  assert.match(both.error?.message ?? "", /matches 2 services in shop/);
  assert.match(both.error.message, new RegExp(`${PROD_RT}  shop/prod/functions-runtime`));
  assert.match(both.error.message, new RegExp(`${DEV_RT}  shop/dev/functions-runtime`));

  assert.equal((await resolve("functions-runtime", { project: SHOP, env: "dev" }, routes)).id, DEV_RT);
  assert.equal((await resolve("functions-runtime", { env: `${SHOP}/prod` }, routes)).id, PROD_RT);
  assert.match(
    (await resolve("functions-runtime", { project: SHOP, env: "staging" }, routes)).error.message,
    /shop has no environment called 'staging'\. It has: prod, dev\./,
  );
});

test("project/name and a bare unique name still resolve account-wide", async () => {
  const qualified = await resolve("shop/functions-runtime", {}, [otherProjects]);
  assert.equal(qualified.id, PROD_RT);
  assert.ok(qualified.sent.every((r) => r.path === "/services"));
  const bare = await resolve("functions-runtime", {}, [otherProjects]);
  assert.match(bare.error.message, /matches 2 services/);
});

test("env set --service functions-runtime --project shop --env prod writes to that service", async () => {
  const result = await run(
    [
      ...tree([
        ["e1", "prod", [runtime(PROD_RT)]],
        ["e2", "dev", [runtime(DEV_RT)]],
      ]),
      ["PATCH", /\/env-vars$/, { needsRedeploy: false, warnings: [], envVars: [] }],
    ],
    () =>
      envSet("GREETING", "hello", {
        service: "functions-runtime",
        project: SHOP,
        env: "prod",
        scope: "prod",
        secret: false,
        json: false,
      }),
  );
  assert.equal(result.error, undefined, result.err);
  const patch = result.sent.find((r) => r.method === "PATCH");
  assert.equal(patch.path, `/services/${PROD_RT}/env-vars`);
});
