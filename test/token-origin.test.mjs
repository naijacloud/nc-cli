// A saved login only goes to the API origin it was issued for (TGL-1174).
//
// These run the built CLI as a child process against a real listener on
// 127.0.0.1, with a throwaway home directory holding a fake saved login, and
// assert on what actually arrives over the wire: a refused request must not
// reach the listener at all, and must never carry an Authorization header.
// os.homedir() reads HOME on POSIX but USERPROFILE on Windows, so both are set.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const SAVED_TOKEN = "fake-saved-session-token";
const ENV_TOKEN = "fake-explicit-env-token";

let server;
let base;
let requests = [];
let home;

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push({ authorization: req.headers.authorization, body, url: req.url });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ id: "u1", email: "ada@kudipay.ng", name: "Ada", status: "ACTIVE", createdAt: "2026-01-01" }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-origin-"));
});

after(() => {
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

function saveLogin(credentials) {
  const dir = path.join(home, ".naijacloud");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(credentials));
}

function run(args, env = {}) {
  const childEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
  delete childEnv.HOSTING_API_TOKEN;
  if (env.HOSTING_API_TOKEN) childEnv.HOSTING_API_TOKEN = env.HOSTING_API_TOKEN;
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: childEnv }, (error, stdout, stderr) => {
      resolve({ code: error ? error.code : 0, stdout, stderr });
    });
  });
}

for (const args of [["whoami"], ["projects", "ls"]]) {
  test(`${args.join(" ")}: a saved prod login is not sent to another host`, async () => {
    saveLogin({ accessToken: SAVED_TOKEN, apiBaseUrl: "https://api.naijacloud.com" });
    const result = await run(args, { HOSTING_API_BASE_URL: base });
    assert.notEqual(result.code, 0);
    assert.equal(requests.length, 0, "the listener must not be contacted");
    assert.match(result.stderr, /saved login belongs to https:\/\/api\.naijacloud\.com/);
    assert.match(result.stderr, /naijacloud login/);
    assert.match(result.stderr, /--token/);
    assert.match(result.stderr, /HOSTING_API_TOKEN/);
    assert.doesNotMatch(result.stderr + result.stdout, new RegExp(SAVED_TOKEN));
    assert.doesNotMatch(result.stderr, /is being sent there/);
  });
}

test("a login saved before the origin was recorded belongs to the default API", async () => {
  saveLogin({ accessToken: SAVED_TOKEN });
  const result = await run(["whoami"], { HOSTING_API_BASE_URL: base });
  assert.notEqual(result.code, 0);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /saved login belongs to https:\/\/api\.naijacloud\.com/);
});

test("a saved login is sent to the origin it was issued for", async () => {
  // A trailing slash or a path does not change the origin.
  saveLogin({ accessToken: SAVED_TOKEN, apiBaseUrl: `${base}/` });
  const result = await run(["whoami"], { HOSTING_API_BASE_URL: base });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${SAVED_TOKEN}`);
});

test("a saved login for another port on the same host is not sent", async () => {
  saveLogin({ accessToken: SAVED_TOKEN, apiBaseUrl: "http://127.0.0.1:1" });
  const result = await run(["whoami"], { HOSTING_API_BASE_URL: base });
  assert.notEqual(result.code, 0);
  assert.equal(requests.length, 0);
});

test("an explicit HOSTING_API_TOKEN is the user's choice and is sent", async () => {
  saveLogin({ accessToken: SAVED_TOKEN, apiBaseUrl: "https://api.naijacloud.com" });
  const result = await run(["whoami"], { HOSTING_API_BASE_URL: base, HOSTING_API_TOKEN: ENV_TOKEN });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${ENV_TOKEN}`);
});

test("a refused base URL gets only the refusal, no warning about sending", async () => {
  saveLogin({ accessToken: SAVED_TOKEN, apiBaseUrl: "https://api.naijacloud.com" });
  for (const url of ["http://example.com", "notaurl", "ftp://x.com"]) {
    const result = await run(["projects", "ls"], { HOSTING_API_BASE_URL: url });
    assert.notEqual(result.code, 0);
    assert.doesNotMatch(result.stderr, /Warning/);
    assert.doesNotMatch(result.stderr, /saved login belongs/);
    assert.equal(result.stderr.trim().split("\n").length, 1, result.stderr);
  }
  assert.equal(requests.length, 0);
});
