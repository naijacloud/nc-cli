// TGL-1170: `deploy --help` deployed, `-h` and `-qa` became arguments, unknown
// or misspelt flags were dropped (so `--servcie api` acted on the linked
// service), and nothing could pass a value that starts with --.
// These run the built CLI as a child process, with the API pointed at a closed
// local port so anything that reaches the network fails loudly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../build/cli.js", import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "nc-cli-args-"));

function cli(args, cwd = home) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HOSTING_API_TOKEN: "test-token",
      HOSTING_API_BASE_URL: "http://127.0.0.1:1",
      HOSTING_API_TIMEOUT_MS: "2000",
    },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

test("deploy --help and -h print deploy's help and deploy nothing", () => {
  const site = fs.mkdtempSync(path.join(os.tmpdir(), "nc-site-"));
  fs.writeFileSync(path.join(site, "index.html"), "<h1>x</h1>");
  fs.writeFileSync(
    path.join(site, "naijacloud.json"),
    JSON.stringify({ version: 1, name: "x", output: ".", serviceId: "11111111-1111-4111-8111-111111111111" }),
  );
  for (const flag of ["--help", "-h"]) {
    const { code, out, err } = cli(["deploy", flag, "--no-wait"], site);
    assert.equal(code, 0, err);
    assert.match(out, /naijacloud deploy \[dir\]/);
    assert.match(out, /Deploy options/);
    assert.doesNotMatch(err, /Cannot reach|Packag/);
  }
});

test("every command has its own help, and `help <command>` shows it", () => {
  for (const command of ["services", "env", "db", "domains", "login", "projects"]) {
    const { code, out } = cli([command, "--help"]);
    assert.equal(code, 0);
    assert.match(out, new RegExp(`naijacloud ${command} `));
  }
  const { code, out } = cli(["help", "services"]);
  assert.equal(code, 0);
  assert.match(out, /Services create options/);
});

test("an unknown or misspelt option fails with exit 2 and a suggestion", () => {
  const typo = cli(["env", "rm", "KEY", "--servcie", "api"]);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /Unknown option --servcie for env \(did you mean --service\?\)/);

  const bogus = cli(["services", "ls", "--bogus"]);
  assert.equal(bogus.code, 2);
  assert.match(bogus.err, /Unknown option --bogus/);
});

test("a single-dash token is not an argument", () => {
  const { code, err } = cli(["projects", "create", "-qa"]);
  assert.equal(code, 2);
  assert.match(err, /Unknown option -qa/);
});

test("a value flag with no value is an error, not a fall-back", () => {
  const { code, err } = cli(["domains", "rm", "app.example.com", "--service"]);
  assert.equal(code, 2);
  assert.match(err, /--service needs a value/);
});

test("-- ends the options, so a value may start with --", () => {
  const { code, err } = cli([
    "env", "set", "NODE_OPTIONS", "--service", "11111111-1111-4111-8111-111111111111",
    "--", "--max-old-space-size=4096",
  ]);
  // It gets as far as the network (a closed port), which is the point: the
  // value was accepted rather than reported missing.
  assert.equal(code, 1);
  assert.doesNotMatch(err, /No value for NODE_OPTIONS|Unknown option/);
  assert.match(err, /Cannot reach/);
});

test("a stray extra argument is an error", () => {
  const { code, err } = cli(["env", "set", "A", "b", "c"]);
  assert.equal(code, 2);
  assert.match(err, /Unexpected argument 'c'/);
});

test("an unknown command exits 2 with a suggestion", () => {
  const { code, err } = cli(["deplyo"]);
  assert.equal(code, 2);
  assert.match(err, /did you mean deploy/);
});
