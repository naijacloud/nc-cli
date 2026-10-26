// `naijacloud argus`: source maps, deploy markers and a test event, sent to
// Argus with an upload token. These run the built CLI as a child process
// against a local stand-in for argus-api / argus-in, so the request each
// command makes is checked exactly as it leaves the CLI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-argus-"));
const TOKEN = "argus_up_test0123456789";

/** A stand-in Argus that records requests and answers from `reply`. */
async function argus(reply) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      const request = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body };
      seen.push(request);
      const [status, json] = reply(request);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}

function cli(args, env = {}, cwd = home) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ARGUS_UPLOAD_TOKEN: "",
          ARGUS_RELEASE: "",
          ARGUS_ENVIRONMENT: "",
          ARGUS_DSN: "",
          SENTRY_DSN: "",
          ...env,
        },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, out: stdout, err: stderr }),
    );
  });
}

/** dist/ with two maps, a nested one, and things that must be skipped. */
function build() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-dist-"));
  fs.mkdirSync(path.join(dir, "assets", "chunks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "index-a1.js.map"), '{"version":3,"mappings":""}');
  fs.writeFileSync(path.join(dir, "assets", "chunks", "vendor.js.map"), '{"version":3,"mappings":""}');
  fs.writeFileSync(path.join(dir, "assets", "index-a1.js"), "x()");
  fs.writeFileSync(path.join(dir, "node_modules", "dep", "x.js.map"), "{}");
  return dir;
}

test("sourcemaps upload sends every map, named after its file, with the token and release", async () => {
  const stub = await argus(() => [201, { name: "ok" }]);
  try {
    const dist = build();
    const r = await cli(["argus", "sourcemaps", "upload", dist, "--release", "shop@1.4.2"], {
      ARGUS_UPLOAD_TOKEN: TOKEN,
      ARGUS_API_URL: stub.base,
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /2 of 2 source maps uploaded for release shop@1\.4\.2/);
    const names = stub.seen.map((s) => s.query.name).sort();
    assert.deepEqual(names, ["~/assets/chunks/vendor.js", "~/assets/index-a1.js"]);
    for (const s of stub.seen) {
      assert.equal(s.method, "POST");
      assert.equal(s.path, "/v1/cli/sourcemaps");
      assert.equal(s.query.release, "shop@1.4.2");
      assert.equal(s.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(s.body, '{"version":3,"mappings":""}');
    }
  } finally {
    await stub.close();
  }
});

test("--url-prefix, ARGUS_RELEASE and --dry-run: lists the plan and sends nothing", async () => {
  const stub = await argus(() => [201, {}]);
  try {
    const r = await cli(["argus", "sourcemaps", "upload", build(), "--url-prefix", "~/static", "--dry-run", "--json"], {
      ARGUS_UPLOAD_TOKEN: TOKEN,
      ARGUS_API_URL: stub.base,
      ARGUS_RELEASE: "2.0.0",
    });
    assert.equal(r.code, 0, r.err);
    const plan = JSON.parse(r.out);
    assert.equal(plan.release, "2.0.0");
    assert.deepEqual(
      plan.maps.map((m) => m.name),
      ["~/static/assets/chunks/vendor.js", "~/static/assets/index-a1.js"],
    );
    assert.equal(stub.seen.length, 0);
  } finally {
    await stub.close();
  }
});

test("a map Argus refuses fails the command and says why", async () => {
  const stub = await argus((req) =>
    req.query.name.includes("vendor") ? [400, { error: "this isn't a version 3 source map" }] : [201, {}],
  );
  try {
    const r = await cli(["argus", "sourcemaps", "upload", build(), "--release", "1"], {
      ARGUS_UPLOAD_TOKEN: TOKEN,
      ARGUS_API_URL: stub.base,
    });
    assert.equal(r.code, 1);
    assert.match(r.err, /✗ ~\/assets\/chunks\/vendor\.js: this isn't a version 3 source map/);
    assert.match(r.out, /1 of 2 source maps uploaded/);
  } finally {
    await stub.close();
  }
});

test("without a usable token nothing is sent, and the message says what to do", async () => {
  const stub = await argus(() => [201, {}]);
  try {
    const none = await cli(["argus", "sourcemaps", "upload", build(), "--release", "1"], { ARGUS_API_URL: stub.base });
    assert.equal(none.code, 1);
    assert.match(none.err, /Set ARGUS_UPLOAD_TOKEN/);

    const dsn = await cli(["argus", "whoami"], { ARGUS_UPLOAD_TOKEN: "https://k@argus-in.naijacloud.com/2", ARGUS_API_URL: stub.base });
    assert.match(dsn.err, /should start with argus_up_/);
    assert.equal(stub.seen.length, 0);
  } finally {
    await stub.close();
  }
});

test("a revoked token is reported as revoked", async () => {
  const stub = await argus(() => [401, { error: "upload token not accepted" }]);
  try {
    const r = await cli(["argus", "whoami"], { ARGUS_UPLOAD_TOKEN: TOKEN, ARGUS_API_URL: stub.base });
    assert.equal(r.code, 1);
    assert.match(r.err, /refused the upload token\. It may have been revoked/);
  } finally {
    await stub.close();
  }
});

test("--release is required, and a missing folder is a usage error", async () => {
  const noRelease = await cli(["argus", "sourcemaps", "upload", build()], { ARGUS_UPLOAD_TOKEN: TOKEN });
  assert.equal(noRelease.code, 1);
  assert.match(noRelease.err, /--release is required/);

  const noDir = await cli(["argus", "sourcemaps", "upload"]);
  assert.equal(noDir.code, 2);

  const typo = await cli(["argus", "sourcemap", "upload"]);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /Unknown argus subcommand 'sourcemap'/);
});

test("deploys new records the release, environment, commit and link", async () => {
  const stub = await argus(() => [201, { source: "shop-web" }]);
  try {
    const r = await cli(
      ["argus", "deploys", "new", "--release", "1.4.2", "--environment", "staging", "--commit", "a91c2f0", "--url", "https://ci/run/1"],
      { ARGUS_UPLOAD_TOKEN: TOKEN, ARGUS_API_URL: stub.base },
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Deploy of 1\.4\.2 to staging recorded for shop-web/);
    assert.equal(stub.seen[0].path, "/v1/cli/deploys");
    assert.deepEqual(JSON.parse(stub.seen[0].body), {
      release: "1.4.2",
      environment: "staging",
      commitSha: "a91c2f0",
      url: "https://ci/run/1",
    });
  } finally {
    await stub.close();
  }
});

test("test sends one event envelope to the DSN's project with its key", async () => {
  const stub = await argus(() => [200, { id: "x" }]);
  try {
    const dsn = `${stub.base.replace("://", "://abc123@")}/41`;
    const r = await cli(["argus", "test", "--dsn", dsn, "--json"]);
    assert.equal(r.code, 0, r.err);
    const { eventId } = JSON.parse(r.out);
    const req = stub.seen[0];
    assert.equal(req.path, "/api/41/envelope/");
    assert.match(req.headers["x-sentry-auth"], /sentry_key=abc123/);
    const [, item, event] = req.body.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(item.type, "event");
    assert.equal(event.event_id, eventId);
    assert.equal(event.tags.argus_test, "true");
  } finally {
    await stub.close();
  }
});

test("test refuses something that isn't a DSN", async () => {
  const r = await cli(["argus", "test", "--dsn", "argus_up_nope"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /That isn't a DSN/);
});
