// TGL-2020: `redeploy` printed RUNNING and the URL, then the process stayed
// alive for ten minutes on a handle nobody could name, which hangs a CI job
// that gates on it. Each run here preloads a timer that never ends, standing
// in for that handle: the CLI must still exit when its command is done, with
// the command's exit code and its whole output.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-exit-"));
const LINGER = "--import=data:text/javascript,setInterval(()=>{},60000)";
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  HOSTING_API_TOKEN: "test-token",
  HOSTING_API_BASE_URL: "http://127.0.0.1:1",
  HOSTING_API_TIMEOUT_MS: "2000",
};

function cli(args) {
  const result = spawnSync(process.execPath, [LINGER, CLI, ...args], {
    cwd: home,
    encoding: "utf8",
    env,
    timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.notEqual(result.signal, "SIGTERM", `njc ${args.join(" ")} did not exit on its own`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("a finished command exits even while something holds the event loop open", () => {
  const { code, out } = cli(["--version"]);
  assert.equal(code, 0);
  assert.match(out, /^\d+\.\d+\.\d+\n$/);
});

test("a failed command exits with its own code", () => {
  const { code, err } = cli(["redeploy", "11111111-1111-4111-8111-111111111111"]);
  assert.equal(code, 1);
  assert.match(err, /Cannot reach the NaijaCloud API/);

  assert.equal(cli(["no-such-command"]).code, 2);
});

test("exiting early does not cut off output written to a pipe", () => {
  const { code, out } = cli(["schema"]);
  assert.equal(code, 0);
  const expected = fs.readFileSync(fileURLToPath(new URL("../schema/naijacloud.schema.json", import.meta.url)), "utf8");
  assert.equal(out.trim(), expected.trim());
});

test("mcp keeps running after main() returns", async () => {
  const child = spawn(process.execPath, [CLI, "mcp"], { cwd: home, env, stdio: ["pipe", "pipe", "pipe"] });
  const exited = new Promise((resolve) => child.once("exit", () => resolve(true)));
  const alive = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve(false), 1_500))]);
  child.kill();
  assert.equal(alive, false, "njc mcp exited instead of serving");
});
