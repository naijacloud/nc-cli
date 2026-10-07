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

/** Answers by operation name; `script` can override any of them per test. */
function stub(script = {}) {
  calls = [];
  globalThis.fetch = async (_url, init) => {
    const { query, variables } = JSON.parse(init.body);
    const op = /(?:mutation|query)\s+(\w+)/.exec(query)?.[1];
    calls.push({ op, variables, authorization: init.headers.authorization });
    const answer = script[op];
    if (typeof answer === "function") return Response.json(answer(variables));
    if (answer) return Response.json(answer);
    if (op === "CurrentUser") {
      return Response.json({ data: { getMe: { id: "u1", email: "ada@kudipay.ng", name: "Ada", status: "ACTIVE" } } });
    }
    return Response.json({ errors: [{ message: `unexpected ${op}` }] });
  };
}

const CHALLENGE = {
  data: {
    login: {
      accessToken: null,
      user: null,
      twoFactor: { pendingToken: "pending-1", expiresAt: "2026-10-07T10:00:00Z" },
    },
  },
};

const stored = () =>
  JSON.parse(fs.readFileSync(path.join(home, ".naijacloud", "config.json"), "utf8"));

before(async () => {
  for (const k of HOME_VARS) process.env[k] = home;
  process.env.HOSTING_API_BASE_URL = "http://api.test";
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
    VerifyTwoFactorSignIn: (v) => {
      assert.deepEqual(v.input, { pendingToken: "pending-1", code: "123456" });
      return { data: { verifyTwoFactorSignIn: { accessToken: "session-2fa", user: { id: "u1", email: "ada@kudipay.ng" } } } };
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
    VerifyTwoFactorSignIn: {
      errors: [{ message: "That code isn’t right. Check your authenticator app and try again.", extensions: { code: "BAD_REQUEST" } }],
    },
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
    VerifyTwoFactorSignIn: {
      errors: [{ message: "Your sign-in timed out.", extensions: { code: "UNAUTHENTICATED" } }],
    },
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
    Login: { data: { login: { accessToken: "session-plain", user: { id: "u1", email: "ada@kudipay.ng" }, twoFactor: null } } },
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
