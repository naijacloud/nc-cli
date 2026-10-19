// TGL-1177: `services create` only took a GitHub-App repository, so without the
// app the CLI could not deploy an app at all. It now takes the dashboard's
// three sources: --repo (GitHub App), --git (public URL), --image (Docker).
// The body sent is checked against the REST API's documented create body.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const openapi = JSON.parse(
  fs.readFileSync(fileURLToPath(new URL("./fixtures/openapi.json", import.meta.url)), "utf8"),
);
const CREATE_BODY = openapi.components.schemas.V1CreateServiceBody;
const ENVIRONMENT = "22222222-2222-4222-8222-222222222222";

/** Every key is one the API documents, and every required key is there. */
function checkBody(body) {
  const unknown = Object.keys(body).filter((key) => !(key in CREATE_BODY.properties));
  assert.deepEqual(unknown, [], `fields the API does not take: ${unknown.join(", ")}`);
  const missing = (CREATE_BODY.required ?? []).filter((key) => body[key] === undefined);
  assert.deepEqual(missing, [], `required fields missing: ${missing.join(", ")}`);
}

async function create(options, reply = {}) {
  const { servicesCreate } = await import("../build/commands/services.js");
  const realFetch = globalThis.fetch;
  const realErr = process.stderr.write;
  const realOut = process.stdout.write;
  const sent = [];
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    sent.push({ method, path, body });
    if (method === "POST" && path === `/v1/environments/${ENVIRONMENT}/services`) {
      if (reply.createError) {
        return Response.json({ error: { code: "BAD_REQUEST", message: reply.createError, requestId: "r" } }, { status: 400 });
      }
      return Response.json(
        { id: "s1", environmentId: ENVIRONMENT, name: "web", type: "WEB", status: "ACTIVE", url: null, isStatic: false, source: {}, build: {}, health: "UNKNOWN" },
        { status: 201 },
      );
    }
    if (/\/github\/install-url$/.test(path)) {
      return Response.json({ url: "https://github.com/apps/naijacloud/installations/new?state=x" });
    }
    if (/\/deploys$/.test(path)) return Response.json({ data: [], nextCursor: null });
    if (path === `/v1/environments/${ENVIRONMENT}`) {
      return Response.json({ id: ENVIRONMENT, projectId: "p1", name: "dev", isPreview: false });
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "unexpected", requestId: "r" } }, { status: 404 });
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
  const call = sent.find(({ method, path }) => method === "POST" && path.endsWith("/services"));
  if (call) checkBody(call.body);
  return { input: call?.body, error, sent };
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
