// Every GraphQL document the CLI sends must be valid against the API's schema.
//
// The CLI hand-writes its operations, and the API renamed most of them after
// 1.1.0 shipped (`me` -> `getMe`, `login(input:)` -> `login(LoginInput:)`, lists
// paginated) — every command then failed with HTTP 400 and nothing noticed.
// This calls every exported API function with fetch stubbed out, records each
// document it sends, and validates them all.
//
// The schema is a snapshot of nc-control-plane's src/schema.gql in
// test/fixtures. Point NAIJACLOUD_SCHEMA at a fresher copy to check against it.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSchema, parse, validate } from "graphql";

const schemaPath =
  process.env.NAIJACLOUD_SCHEMA ?? fileURLToPath(new URL("./fixtures/schema.gql", import.meta.url));
const schema = buildSchema(fs.readFileSync(schemaPath, "utf8"));

/** Answers that let a multi-step function get past its first request. */
const CANNED = {
  getMyTeams: { items: [{ id: "t1", name: "Team", defaultRegion: null }], pageInfo: { hasNextPage: false } },
};

async function captureDocuments() {
  const sent = new Map();
  let caller = "";
  const realFetch = globalThis.fetch;
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    if (!sent.has(query)) sent.set(query, new Set());
    sent.get(query).add(caller);
    for (const [field, value] of Object.entries(CANNED)) {
      if (new RegExp(`\\b${field}\\b`).test(query)) {
        return Response.json({ data: { [field]: value } });
      }
    }
    return Response.json({ errors: [{ message: "stubbed" }] });
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
      if (/^(execute|authed|authedAllPages|apiBaseUrl|pageSelection|siteUrl|is[A-Z])/.test(name)) continue;
      if (/Error$/.test(name)) continue;
      caller = name;
      for (const args of shapes) {
        try {
          await fn(...args);
        } catch {
          /* the stub fails most calls; only the documents matter */
        }
      }
    }
  } finally {
    globalThis.fetch = realFetch;
  }
  return sent;
}

test("every operation the CLI sends is valid against the API schema", async () => {
  const sent = await captureDocuments();
  // A floor, so a broken capture cannot pass by sending nothing.
  assert.ok(sent.size >= 40, `expected to capture 40+ documents, got ${sent.size}`);

  const failures = [];
  for (const [query, callers] of sent) {
    const errors = validate(schema, parse(query));
    if (errors.length > 0) {
      failures.push(`${[...callers].join(", ")}:\n    ${errors.map((e) => e.message).join("\n    ")}`);
    }
  }
  assert.deepEqual(failures, [], `invalid operations:\n${failures.join("\n")}`);
});

test("projects are read per team after the team list", async () => {
  const sent = await captureDocuments();
  assert.ok(
    [...sent.keys()].some((query) => /\bgetProjects\b/.test(query)),
    "listProjects never asked for a team's projects",
  );
});
