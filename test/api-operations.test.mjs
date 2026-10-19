// Every request the CLI sends must be a route the REST API has (TGL-1406).
//
// The CLI hand-writes its calls, and an API that renames or drops a route
// makes every command that uses it fail. This calls every exported API
// function with fetch stubbed out, records each method + path it sends, and
// checks them all against the API's OpenAPI document.
//
// The document is a snapshot of nc-control-plane's src/api-v1/openapi.json in
// test/fixtures. Point NAIJACLOUD_OPENAPI at a fresher copy to check against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

// The login calls send the device id, which creates ~/.naijacloud/device; keep
// that in a throwaway home rather than the developer's.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-ops-"));
process.env.HOME = home;
process.env.USERPROFILE = home;

const openapiPath =
  process.env.NAIJACLOUD_OPENAPI ?? fileURLToPath(new URL("./fixtures/openapi.json", import.meta.url));
const openapi = JSON.parse(fs.readFileSync(openapiPath, "utf8"));

/** Each documented route as a regex over the path after `/v1`, with its methods. */
const ROUTES = Object.entries(openapi.paths).map(([route, operations]) => ({
  route,
  pattern: new RegExp(`^${route.replace(/^\/v1/, "").replace(/\{[^}]+\}/g, "[^/]+")}$`),
  methods: new Set(Object.keys(operations).map((method) => method.toUpperCase())),
}));

/**
 * Routes the CLI already calls but the API has not shipped yet (TGL-1405).
 * Each has a fallback that works without it — prices point at the pricing page,
 * an environment is found by walking the workspace's projects — so a missing
 * route degrades the output instead of breaking a command. Remove an entry as
 * soon as its route is in the OpenAPI snapshot; the test below fails on a
 * stale entry so that cannot be forgotten.
 */
const PENDING = new Set(["GET /pricing", "GET /environments/{id}"]);
const pendingKey = (method, route) => `${method} ${route.replace(/^\/environments\/[^/]+$/, "/environments/{id}")}`;

/** Answers that let a multi-step function get past its first request. */
const CANNED = [
  [/^\/workspaces$/, { data: [{ id: "t1", name: "Team", defaultRegion: null }], nextCursor: null }],
  [/^\/projects\/[^/]+\/environments$/, { data: [{ id: "e1", projectId: "p1", name: "dev", isPreview: false }], nextCursor: null }],
  [/^\/environments\/[^/]+\/services$/, { data: [{ id: "s1", environmentId: "e1", name: "api", type: "WEB", status: "ACTIVE", url: null, isStatic: false, source: {}, build: {}, health: "HEALTHY" }], nextCursor: null }],
  [/^\/workspaces\/[^/]+\/projects$/, { data: [{ id: "p1", workspaceId: "t1", name: "shop" }], nextCursor: null }],
  [/^\/services\/[^/]+$/, { id: "s1", environmentId: "e1", name: "api", type: "WEB", status: "ACTIVE", source: {}, build: {} }],
  [/^\/deploys\/[^/]+$/, { id: "d1", serviceId: "s1", status: "RUNNING" }],
];

async function captureRequests() {
  const sent = new Map();
  let caller = "";
  const realFetch = globalThis.fetch;
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const route = url.pathname.replace(/^\/v1/, "");
    const key = `${method} ${route}`;
    if (!sent.has(key)) sent.set(key, new Set());
    sent.get(key).add(caller);
    if (method === "GET") {
      for (const [pattern, body] of CANNED) if (pattern.test(route)) return Response.json(body);
    }
    return Response.json({ error: { code: "BAD_REQUEST", message: "stubbed" } }, { status: 400 });
  };
  try {
    const api = await import("../build/api/index.js");
    const s = "x";
    const shapes = [
      [s, s, s, s],
      [{ teamId: s, projectId: s, environmentId: s, name: s, serviceId: s, uploadId: s, type: "WEB", repoFullName: s, filename: s, contentType: s, sizeBytes: 1 }],
      [s, [{ key: "A", value: "b" }]],
    ];
    for (const [name, fn] of Object.entries(api)) {
      if (typeof fn !== "function") continue;
      if (/^(execute|authed|authedList|apiBaseUrl|requestToken|siteUrl|is[A-Z]|to[A-Z]|seg$|dnsRecordsFor|formatDnsRecord)/.test(name)) continue;
      if (/Error$/.test(name)) continue;
      caller = name;
      for (const args of shapes) {
        try {
          await fn(...args);
        } catch {
          /* the stub fails most calls; only the requests matter */
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("every request the CLI sends is a route the REST API documents", async () => {
  const sent = await captureRequests();
  // A floor, so a broken capture cannot pass by sending nothing.
  assert.ok(sent.size >= 30, `expected to capture 30+ distinct requests, got ${sent.size}`);

  const failures = [];
  for (const [key, callers] of sent) {
    const [method, route] = key.split(" ");
    if (PENDING.has(pendingKey(method, route))) continue;
    const documented = ROUTES.find(({ pattern }) => pattern.test(route));
    if (!documented) failures.push(`${key} (from ${[...callers].join(", ")}): no such route`);
    else if (!documented.methods.has(method)) {
      failures.push(`${key} (from ${[...callers].join(", ")}): ${documented.route} has no ${method}`);
    }
  }
  assert.deepEqual(failures, [], `requests the API does not have:\n${failures.join("\n")}`);
});

test("a pending route leaves the list as soon as the API documents it", () => {
  const stale = [...PENDING].filter((key) => {
    const [method, route] = key.split(" ");
    const sample = route.replace("{id}", "x");
    const documented = ROUTES.find(({ pattern }) => pattern.test(sample));
    return documented?.methods.has(method);
  });
  assert.deepEqual(stale, [], `now documented, remove from PENDING: ${stale.join(", ")}`);
});

test("projects are read per workspace after the workspace list", async () => {
  const sent = await captureRequests();
  assert.ok(
    [...sent.keys()].some((key) => /^GET \/workspaces\/[^/]+\/projects$/.test(key)),
    "listProjects never asked for a workspace's projects",
  );
});

test("the CLI sends nothing to GraphQL", async () => {
  const sent = await captureRequests();
  assert.ok(![...sent.keys()].some((key) => /graphql/i.test(key)), "a request went to /graphql");
});
