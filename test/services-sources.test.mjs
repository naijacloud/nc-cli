// TGL-1177: `services create` only took a GitHub-App repository, so without the
// app the CLI could not deploy an app at all. It now takes the dashboard's
// three sources: --repo (GitHub App), --git (public URL), --image (Docker).
// The variables sent are validated against the API schema's input types.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchema, getVariableValues, parse } from "graphql";

const schema = buildSchema(
  fs.readFileSync(fileURLToPath(new URL("./fixtures/schema.gql", import.meta.url)), "utf8"),
);
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

function checkVariables(query, variables) {
  const operation = parse(query).definitions[0];
  const { errors } = getVariableValues(schema, operation.variableDefinitions ?? [], variables);
  assert.equal(errors, undefined, errors?.map((e) => e.message).join("; "));
}

async function create(options, reply = {}) {
  const { servicesCreate } = await import("../build/commands/services.js");
  const realFetch = globalThis.fetch;
  const realErr = process.stderr.write;
  const realOut = process.stdout.write;
  const sent = [];
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    sent.push({ query, variables });
    if (/createService/.test(query)) {
      if (reply.createError) return Response.json({ data: null, errors: [{ message: reply.createError }] });
      return Response.json({ data: { createService: { id: "s1", name: "web", type: "WEB", status: "ACTIVE" } } });
    }
    if (/getGithubAppInstallUrl/.test(query)) return Response.json({ data: { getGithubAppInstallUrl: "https://github.com/apps/naijacloud/installations/new?state=x" } });
    if (/getServiceDeployments|getDeployments/.test(query)) return Response.json({ data: { getDeployments: { items: [], pageInfo: { hasNextPage: false } } } });
    return Response.json({ data: null, errors: [{ message: "unexpected" }] });
  };
  process.stderr.write = () => true;
  process.stdout.write = () => true;
  let error;
  try {
    await servicesCreate("web", {
      env: ENVIRONMENT, repo: undefined, git: undefined, image: undefined, branch: undefined,
      type: undefined, build: undefined, start: undefined, command: undefined, port: undefined,
      rootDir: undefined, runtimeVersion: undefined, schedule: undefined, healthCheck: undefined,
      region: undefined, tier: undefined, envFile: undefined, noEnvFile: true, scope: undefined,
      secret: false, wait: false, json: false, ...options,
    });
  } catch (caught) {
    error = caught;
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realErr;
    process.stdout.write = realOut;
  }
  const call = sent.find(({ query }) => /createService/.test(query));
  if (call) checkVariables(call.query, call.variables);
  return { input: call?.variables.input, error, sent };
}

test("--git sends a public git source, exactly as the dashboard does", async () => {
  const { input, error } = await create({ git: "https://github.com/naijacloud/template-go-api/", branch: "main" });
  assert.equal(error, undefined);
  assert.equal(input.sourceType, "PUBLIC_GIT");
  assert.equal(input.gitUrl, "https://github.com/naijacloud/template-go-api");
  assert.equal(input.repoFullName, undefined);
  assert.equal(input.tier, "FREE");
});

test("--image sends a Docker source, and --start becomes the image command", async () => {
  const { input, error } = await create({ image: "ghcr.io/acme/api:1.8.0", start: "./serve" });
  assert.equal(error, undefined);
  assert.equal(input.sourceType, "DOCKER_IMAGE");
  assert.equal(input.image, "ghcr.io/acme/api:1.8.0");
  assert.equal(input.imageCommand, "./serve");
  assert.equal(input.startCommand, undefined);
});

test("a cron job's command goes in `command`, which the API reads", async () => {
  const { input, error } = await create({
    type: "cron", git: "https://gitlab.com/acme/jobs", schedule: "0 3 * * *", command: "node cleanup.js",
  });
  assert.equal(error, undefined);
  assert.equal(input.type, "CRON");
  assert.equal(input.command, "node cleanup.js");
});

test("--repo accepts a github.com URL, and refuses two sources", async () => {
  const { normaliseRepo, pickSource } = await import("../build/commands/services.js");
  assert.equal(normaliseRepo("https://github.com/naijacloud/template-go-api.git"), "naijacloud/template-go-api");
  assert.equal(normaliseRepo("github.com/acme/api/"), "acme/api");
  assert.equal(normaliseRepo("git@github.com:acme/api.git"), "acme/api");
  assert.throws(() => normaliseRepo("https://gitlab.com/acme/api"), /--git/);
  assert.throws(() => pickSource({ repo: "a/b", image: "x" }), /Pass one source/);
  assert.throws(() => pickSource({}), /--git <https url>/);
  assert.throws(() => pickSource({ git: "https://ghp_token@github.com/a/b" }), /Remove the username or token/);
  assert.throws(() => pickSource({ git: "http://github.com/a/b" }), /https:\/\//);
  assert.throws(() => pickSource({ image: "postgres:16" }), /database image/);
});

test("no GitHub App installation points at the install link and at --git", async () => {
  const { error, input } = await create(
    { repo: "naijacloud/template-go-api" },
    { createError: 'No connected GitHub installation can access "naijacloud/template-go-api"' },
  );
  assert.equal(input.repoFullName, "naijacloud/template-go-api");
  assert.ok(error);
  assert.match(error.message, /--git https:\/\/github\.com\/naijacloud\/template-go-api/);
});
