// Two-factor sign-in from the CLI (TGL-768): a password login on an account
// with two-factor on answers `twoFactor` instead of a token, and the CLI must
// trade the pending token and a code for the session before saving anything.
// `--token` (API keys, CI) never meets two-factor.
//
// fetch is stubbed; the home directory points at a throwaway directory so the
// credential file this writes is not the developer's. os.homedir() reads HOME
// on POSIX but USERPROFILE on Windows, so both are pointed there.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-2fa-"));
const HOME_VARS = ["HOME", "USERPROFILE"];
const realHome = Object.fromEntries(HOME_VARS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
let auth;
let calls = [];

/** The REST calls the sign-in flow makes, named as the steps they are. */
const OPS = {
  "POST /v1/auth/login": "Login",
  "POST /v1/auth/two-factor": "VerifyTwoFactorSignIn",
  "GET /v1/me": "CurrentUser",
};

/** An error answer in the `/v1` envelope. */
const fail = (status, code, message) => ({ status, error: { code, message, requestId: "r" } });

/**
 * Answers by step; `script` can override any of them per test with a body, a
 * {@link fail}, or a function of the request body returning either.
 */
function stub(script = {}) {
  calls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const op = OPS[`${init.method} ${url.pathname}`] ?? `${init.method} ${url.pathname}`;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ op, body, authorization: init.headers.authorization });
    let answer = script[op];
    if (typeof answer === "function") answer = answer(body);
    if (answer?.error) return Response.json({ error: answer.error }, { status: answer.status });
    if (answer) return Response.json(answer);
    if (op === "CurrentUser") {
      return Response.json({ id: "u1", email: "ada@kudipay.ng", name: "Ada", status: "ACTIVE" });
    }
    return new Response(`unexpected ${op}`, { status: 404 });
  };
}

const CHALLENGE = {
  accessToken: null,
  user: null,
  twoFactor: { pendingToken: "pending-1", expiresAt: "2026-10-07T10:00:00Z" },
};

const stored = () =>
  JSON.parse(fs.readFileSync(path.join(home, ".naijacloud", "config.json"), "utf8"));

before(async () => {
  for (const k of HOME_VARS) process.env[k] = home;
  process.env.HOSTING_API_BASE_URL = "http://localhost:9";
  delete process.env.HOSTING_API_TOKEN;
  // Quiet the progress lines the command writes to stderr/stdout.
  auth = await import("../build/commands/auth.js");
});

after(() => {
  globalThis.fetch = realFetch;
  for (const k of HOME_VARS) {
    if (realHome[k] === undefined) delete process.env[k];
    else process.env[k] = realHome[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test("a two-factor account trades the pending token and --code for the session", async () => {
  stub({
    Login: CHALLENGE,
    VerifyTwoFactorSignIn: (body) => {
      assert.deepEqual(body, { pendingToken: "pending-1", code: "123456" });
      return { accessToken: "session-2fa", user: { id: "u1", email: "ada@kudipay.ng" } };
    },
  });
  await auth.login({ email: "ada@kudipay.ng", password: "pw", code: " 123456 " });
  assert.deepEqual(calls.map((c) => c.op), ["Login", "VerifyTwoFactorSignIn", "CurrentUser"]);
  assert.equal(stored().accessToken, "session-2fa");
  // The session is validated with the token that came from the code step.
  assert.equal(calls[2].authorization, "Bearer session-2fa");
});

test("a wrong --code saves nothing and says why", async () => {
  fs.rmSync(path.join(home, ".naijacloud"), { recursive: true, force: true });
  stub({
    Login: CHALLENGE,
    VerifyTwoFactorSignIn: fail(400, "BAD_REQUEST", "That code isn’t right. Check your authenticator app and try again."),
  });
  await assert.rejects(
    auth.login({ email: "ada@kudipay.ng", password: "pw", code: "000000" }),
    /isn’t right/,
  );
  assert.equal(fs.existsSync(path.join(home, ".naijacloud", "config.json")), false);
});

test("a timed-out pending sign-in asks to start over", async () => {
  stub({
    Login: CHALLENGE,
    VerifyTwoFactorSignIn: fail(401, "UNAUTHENTICATED", "Your sign-in timed out."),
  });
  await assert.rejects(
    auth.login({ email: "ada@kudipay.ng", password: "pw", code: "123456" }),
    /timed out\. Run login again/,
  );
});

test("without --code and without a terminal, it says how to pass the code", async () => {
  stub({ Login: CHALLENGE });
  await assert.rejects(
    auth.login({ email: "ada@kudipay.ng", password: "pw" }),
    (err) => /two-factor/.test(err.message) && /--code/.test(err.message),
  );
  assert.deepEqual(calls.map((c) => c.op), ["Login"]);
});

test("an account without two-factor logs in as before", async () => {
  stub({
    Login: { accessToken: "session-plain", user: { id: "u1", email: "ada@kudipay.ng" }, twoFactor: null },
  });
  await auth.login({ email: "ada@kudipay.ng", password: "pw" });
  assert.deepEqual(calls.map((c) => c.op), ["Login", "CurrentUser"]);
  assert.equal(stored().accessToken, "session-plain");
});

test("--token (an API key) never meets two-factor", async () => {
  stub();
  await auth.login({ token: "nc_live_example" });
  assert.deepEqual(calls.map((c) => c.op), ["CurrentUser"]);
  assert.equal(stored().accessToken, "nc_live_example");
});

// TGL-1171: without a device cookie every password login looked like a new
// device and emailed "New sign-in to your account".
test("password logins send the same device id every time, across logout", async () => {
  const devices = [];
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).pathname === "/v1/auth/login") {
      devices.push(init.headers["x-device-id"]);
      return Response.json(
        { accessToken: "s", user: { id: "u1", email: "a@b.c" }, twoFactor: null },
        { headers: { "x-device-id": init.headers["x-device-id"] } },
      );
    }
    return Response.json({ id: "u1", email: "a@b.c", status: "ACTIVE" });
  };
  await auth.login({ email: "a@b.c", password: "pw" });
  auth.logout();
  await auth.login({ email: "a@b.c", password: "pw" });
  assert.equal(devices.length, 2);
  assert.match(devices[0], /^[0-9a-f]{64}$/);
  assert.equal(devices[1], devices[0]);
  const file = path.join(home, ".naijacloud", "device");
  assert.equal(fs.readFileSync(file, "utf8").trim(), devices[0]);
  if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("an empty --token is refused before any request", async () => {
  stub();
  await assert.rejects(auth.login({ token: "   " }), /--token is empty/);
  assert.equal(calls.length, 0);
});

test("a rejected --token says so once, without telling you to run login", async () => {
  stub({ CurrentUser: fail(401, "UNAUTHENTICATED", "Unauthorized") });
  await assert.rejects(auth.login({ token: "nc_live_bad" }), (err) =>
    /did not accept the token/.test(err.message) && !/Run 'naijacloud login'/.test(err.message),
  );
});

// TGL-1174: a stored login is never sent to a base URL other than the one it
// came from. The request is refused before fetch is called.
test("a saved login used against a different base URL is refused, not sent", async () => {
  stub({ Login: { accessToken: "s1", user: { id: "u1", email: "a@b.c" }, twoFactor: null } });
  await auth.login({ email: "a@b.c", password: "pw" });
  const { getCurrentUser } = await import("../build/api/index.js");
  calls = [];
  process.env.HOSTING_API_BASE_URL = "http://localhost:10";
  try {
    await assert.rejects(getCurrentUser(), (error) => {
      assert.equal(error.code, "LOGIN_FOR_ANOTHER_HOST");
      assert.match(error.message, /belongs to http:\/\/localhost:9.*points at http:\/\/localhost:10/s);
      return true;
    });
  } finally {
    process.env.HOSTING_API_BASE_URL = "http://localhost:9";
  }
  assert.equal(calls.length, 0);
});
