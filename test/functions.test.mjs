// `naijacloud functions` (TGL-1758): name rules, how code on disk becomes the
// upload, the F7 deploy output against a stubbed API, and how the arguments
// are read.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { list, run } from "./rest-stub.mjs";

const source = await import("../build/commands/function-source.js");
const CLI = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const PROJECT = "22222222-2222-4222-8222-222222222222";

/** Entry names in a zip, in order, from its local file headers. */
function zipNames(buffer) {
  const names = [];
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    names.push(buffer.subarray(offset + 30, offset + 30 + nameLength).toString("utf8"));
    offset += 30 + nameLength + extra + size;
  }
  return names;
}

function tempDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-fn-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

test("function names follow the contract's rule", () => {
  for (const name of ["hello", "send-receipt", "a", "a1", "x".repeat(40)]) {
    assert.ok(source.isValidFunctionName(name), name);
  }
  for (const name of ["", "Hello", "send_receipt", "-a", "a-", "x".repeat(41), "a.b", "ọla"]) {
    assert.ok(!source.isValidFunctionName(name), name);
  }
});

test("an invalid name gets the designer's message with a usable suggestion", () => {
  assert.equal(
    source.invalidNameMessage("Send_Receipt"),
    "Function names use lower-case letters, numbers and dashes, up to 40 characters. Try send-receipt.",
  );
  assert.equal(source.suggestFunctionName("--My Func--"), "my-func");
  assert.equal(source.suggestFunctionName("___"), "send-receipt");
  assert.ok(source.isValidFunctionName(source.suggestFunctionName(`a${"-".repeat(39)}b`)));
});

test("a single file is zipped as index.<ext>", () => {
  const dir = tempDir({ "hello.ts": "Deno.serve(() => new Response('hi'))" });
  const bundle = source.bundleFunction(source.locateFunctionSource("hello", dir));
  assert.equal(bundle.source.label, "hello.ts");
  assert.equal(bundle.entrypoint, "index.ts");
  assert.deepEqual(zipNames(bundle.zip), ["index.ts"]);

  const js = tempDir({ "worker.mjs": "export default () => new Response('x')" });
  const fromFile = source.bundleFunction(source.locateFunctionSource("hello", js, "worker.mjs"));
  assert.deepEqual(zipNames(fromFile.zip), ["index.mjs"]);
  assert.throws(
    () => source.bundleFunction(source.locateFunctionSource("hello", js, "worker.mjs"), "main.ts"),
    /--entry is for a folder/,
  );
});

test("a folder is zipped at the root without dependencies, git, .env or dotfiles", () => {
  const dir = tempDir({
    "supabase/functions/hello/index.ts": "import { x } from './lib/x.ts'",
    "supabase/functions/hello/lib/x.ts": "export const x = 1",
    "supabase/functions/hello/node_modules/dep/index.js": "x",
    "supabase/functions/hello/.git/HEAD": "x",
    "supabase/functions/hello/.env": "SECRET=1",
    "supabase/functions/hello/.env.local": "SECRET=1",
    "supabase/functions/hello/lib/.cache": "x",
    "supabase/functions/hello/deno.json": "{}",
    "supabase/functions/hello/package.json": "{}",
    "supabase/functions/hello/package-lock.json": "{}",
    "supabase/functions/hello/tsconfig.json": "{}",
  });
  const bundle = source.bundleFunction(source.locateFunctionSource("hello", dir));
  assert.equal(bundle.source.kind, "folder");
  assert.equal(bundle.source.label, path.join("supabase", "functions", "hello") + path.sep);
  assert.equal(bundle.entrypoint, "index.ts");
  assert.deepEqual(zipNames(bundle.zip), [
    "deno.json",
    "index.ts",
    "lib/x.ts",
    "package-lock.json",
    "package.json",
    "tsconfig.json",
  ]);
  assert.equal(bundle.files, 6);
});

test("the default source order is <name>.ts, supabase/functions, functions, <name>/", () => {
  const dir = tempDir({
    "functions/hello/index.js": "x",
    "hello/index.ts": "x",
  });
  assert.equal(source.locateFunctionSource("hello", dir).label, path.join("functions", "hello") + path.sep);
  fs.mkdirSync(path.join(dir, "supabase", "functions", "hello"), { recursive: true });
  assert.match(source.locateFunctionSource("hello", dir).label, /^supabase/);
  fs.writeFileSync(path.join(dir, "hello.ts"), "x");
  assert.equal(source.locateFunctionSource("hello", dir).label, "hello.ts");
  assert.throws(() => source.locateFunctionSource("other", dir), /No code found for other/);
});

test("a folder needs an entry file, and --entry must exist", () => {
  const dir = tempDir({ "fn/main.ts": "x", "fn/index.js": "y" });
  const located = source.locateFunctionSource("fn", dir);
  assert.equal(source.bundleFunction(located).entrypoint, "index.js");
  assert.equal(source.bundleFunction(located, "main.ts").entrypoint, "main.ts");
  assert.throws(() => source.bundleFunction(located, "nope.ts"), /has no nope\.ts/);
  const empty = tempDir({ "fn/readme.md": "x" });
  assert.throws(
    () => source.bundleFunction(source.locateFunctionSource("fn", empty)),
    /has no index\.ts, index\.js or index\.mjs/,
  );
});

test("over 20 MB is refused with the size in the message", () => {
  assert.equal(source.sizeProblem(20 * 1024 * 1024), null);
  assert.equal(
    source.sizeProblem(25 * 1024 * 1024),
    "Code is 25.0 MB; the limit is 20 MB per deploy.",
  );
  assert.match(source.sizeProblem(20 * 1024 * 1024 + 1), /^Code is 20\.1 MB/);
});

/* ------------------------------------------------------------------------ */
/* Deploy against a stubbed API                                              */
/* ------------------------------------------------------------------------ */

function version(number, overrides = {}) {
  return {
    id: `v${number}`,
    number,
    status: "LIVE",
    sizeBytes: 300,
    entrypoint: "index.ts",
    command: null,
    deployedByName: "Ada",
    deployId: `d${number}`,
    errorMessage: null,
    createdAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

function cloudFunction(overrides = {}) {
  return {
    id: "f1",
    name: "hello",
    url: "https://shop-fn.naijacloud.app/functions/v1/hello",
    status: "LIVE",
    statusDetail: null,
    region: "eu-west",
    tier: "FREE",
    runtimeServiceId: "rt1",
    environmentId: "e1",
    liveVersion: null,
    latestVersion: null,
    calls24h: 12,
    errors24h: 0,
    limits: { memoryMb: 256, maxDurationSeconds: 150, maxCodeBytes: 20971520 },
    createdAt: "2026-10-28T10:00:00.000Z",
    updatedAt: "2026-10-28T10:00:00.000Z",
    ...overrides,
  };
}

const slot = {
  uploadId: "u1",
  url: "https://storage.test/upload/u1",
  method: "PUT",
  headers: [{ name: "content-type", value: "application/zip" }],
  maxBytes: 20971520,
  expiresInSeconds: 600,
};

async function deployIn(dir, routes) {
  const { functionsDeploy } = await import("../build/commands/functions.js");
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    return await run(routes, () =>
      functionsDeploy("hello", {
        project: PROJECT,
        env: undefined,
        file: undefined,
        entry: undefined,
        json: false,
        args: ["deploy", "hello", "--project", PROJECT],
      }),
    );
  } finally {
    process.chdir(cwd);
  }
}

test("deploy prints the F7 steps, the URL on its own line and the next command", async () => {
  const dir = tempDir({ "hello.ts": "Deno.serve(() => new Response('hi'))\n" });
  const result = await deployIn(dir, [
    ["GET", /^\/me$/, { id: "u", email: "ada@acmelabs.ng", createdAt: "2026-01-01T00:00:00Z" }],
    ["POST", /^\/function-uploads$/, slot],
    ["PUT", /^\/upload\/u1$/, undefined],
    [
      "POST",
      /^\/functions$/,
      { function: cloudFunction(), version: version(1), deploy: { id: "d1", serviceId: "rt1", status: "RUNNING" } },
    ],
  ]);
  assert.equal(result.error, undefined, result.err);
  assert.match(result.err, /✓ Logged in as ada@acmelabs\.ng\n/);
  assert.match(result.err, /✓ Found hello\.ts \(1 file, 0\.0 KB\)\n/);
  assert.match(result.err, /✓ Bundled \(\d+\.\d KB\)\n/);
  assert.match(result.err, /✓ Uploaded version 1\n/);
  assert.match(result.err, /✓ Live in eu-west\n/);
  assert.match(result.err, /Next: naijacloud functions logs hello --project /);
  assert.equal(result.out, "https://shop-fn.naijacloud.app/functions/v1/hello\n");
  // The Next line is a command to copy, never wrapped; with a project id it runs long.
  for (const line of result.err.split("\n").filter((l) => !l.includes("Next:"))) {
    assert.ok(line.length <= 80, line);
  }

  const upload = result.sent.find((r) => r.path === "/function-uploads");
  assert.deepEqual(Object.keys(upload.body).sort(), ["name", "projectId", "sizeBytes"]);
  const deploy = result.sent.find((r) => r.method === "POST" && r.path === "/functions");
  assert.equal(deploy.body.entrypoint, "index.ts");
  assert.equal(deploy.body.uploadId, "u1");
  assert.equal(deploy.body.command, `naijacloud functions deploy hello --project ${PROJECT}`);
  const put = result.sent.find((r) => r.method === "PUT");
  assert.equal(put.headers.authorization, undefined, "the presigned PUT must not carry the token");
});

test("a failed deploy shows the reason, the build log and the version still live", async () => {
  const dir = tempDir({ "hello.ts": "import x from 'paystack-sdk'\n" });
  const failed = version(7, {
    status: "FAILED",
    deployId: "d7",
    errorMessage: 'hello.ts:2 cannot find module "paystack-sdk"',
  });
  const result = await deployIn(dir, [
    ["GET", /^\/me$/, { id: "u", email: "ada@acmelabs.ng", createdAt: "2026-01-01T00:00:00Z" }],
    ["POST", /^\/function-uploads$/, slot],
    ["PUT", /^\/upload\/u1$/, undefined],
    [
      "POST",
      /^\/functions$/,
      {
        function: cloudFunction({ liveVersion: version(6), latestVersion: failed }),
        version: failed,
        deploy: { id: "d7", serviceId: "rt1", status: "FAILED" },
      },
    ],
    ["GET", /^\/deploys\/d7$/, { id: "d7", serviceId: "rt1", status: "FAILED", error: "Build failed" }],
    ["GET", /^\/functions\/f1$/, cloudFunction({ liveVersion: version(6), latestVersion: failed })],
    [
      "GET",
      /^\/deploys\/d7\/logs$/,
      list([{ id: "l1", level: "ERROR", stream: "STDERR", line: "error: Module not found \"paystack-sdk\"", createdAt: "x" }]),
    ],
  ]);
  assert.equal(result.error?.name, "ReportedError");
  assert.match(result.err, /✗ Build failed: hello\.ts:2 cannot find module "paystack-sdk"\n/);
  assert.match(result.err, /Module not found "paystack-sdk"/);
  assert.match(result.err, /the previous version \(v6\) is still live\./);
  assert.match(result.err, /deployments logs d7/);
  assert.equal(result.out, "");
});

test("list shows name, status, calls, errors, last deployed and URL", async () => {
  const { functionsList } = await import("../build/commands/functions.js");
  const result = await run(
    [["GET", /^\/projects\/[^/]+\/functions$/, list([cloudFunction({ liveVersion: version(2) })])]],
    () => functionsList({ project: PROJECT, env: undefined, json: false }),
  );
  assert.equal(result.error, undefined, result.err);
  assert.match(result.out, /^NAME\s+STATUS\s+CALLS 24H\s+ERRORS 24H\s+LAST DEPLOYED\s+URL\n/);
  assert.match(result.out, /hello\s+LIVE\s+12\s+0\s+2026-10-28 \d\d:\d\d\s+https:\/\/shop-fn/);
});

test("delete --yes finds the function by name and deletes it by id", async () => {
  const { functionsDelete } = await import("../build/commands/functions.js");
  const result = await run(
    [
      ["GET", /^\/projects\/[^/]+\/functions$/, list([cloudFunction(), cloudFunction({ id: "f2", name: "hello-two" })])],
      ["DELETE", /^\/functions\/f1$/, undefined],
    ],
    () => functionsDelete("hello", { project: PROJECT, env: undefined, yes: true, json: false }),
  );
  assert.equal(result.error, undefined, result.err);
  assert.ok(result.sent.some((r) => r.method === "DELETE" && r.path === "/functions/f1"));
  assert.match(result.out, /Deleted hello\./);
});

/* ------------------------------------------------------------------------ */
/* Arguments, through the built CLI                                          */
/* ------------------------------------------------------------------------ */

function cli(args, cwd) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-fn-home-"));
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: cwd ?? home,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOSTING_API_TOKEN: "test-token",
      // Closed port: anything that reaches the network fails loudly.
      HOSTING_API_BASE_URL: "http://127.0.0.1:1",
      HOSTING_API_TIMEOUT_MS: "2000",
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("an invalid name is refused before any request, in the F7 form", () => {
  const { code, out, err } = cli(["functions", "deploy", "Send_Receipt", "--project", "shop"]);
  assert.equal(code, 1);
  assert.equal(out, "");
  assert.equal(
    err,
    "\n  ✗ Function names use lower-case letters, numbers and dashes, up to 40\n" +
      "    characters. Try send-receipt.\n",
  );
});

test("missing code and oversized code fail locally", () => {
  const dir = tempDir({});
  const missing = cli(["functions", "deploy", "hello", "--project", "shop"], dir);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /✗ No code found for hello/);
  assert.doesNotMatch(missing.err, /Cannot reach/);
});

test("--project is required, and functions has its own help", () => {
  const noProject = cli(["functions", "deploy", "hello"]);
  assert.equal(noProject.code, 2);
  assert.match(noProject.err, /--project is required/);

  const help = cli(["functions", "--help"]);
  assert.equal(help.code, 0);
  assert.match(help.out, /naijacloud functions deploy <name>/);
  assert.match(help.out, /Functions options/);

  const unknown = cli(["functions", "invoke", "hello", "--project", "shop"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Use one of: deploy, list, logs, delete/);
});
