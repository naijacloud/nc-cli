// A static bundle is public, so no dotenv-style file may ever be uploaded —
// `production.env` used to slip through because only `.env` / `.env.*` matched.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("every env-file naming is left out of the archive", async () => {
  const { selectFiles } = await import("../build/deploy-static/manifest.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-site-"));
  const secrets = [".env", ".env.local", ".env.production", "production.env", "db.env", "App.ENV", ".envrc"];
  for (const name of [...secrets, "index.html", "environment.js", "env.json"]) {
    fs.writeFileSync(path.join(dir, name), "x");
  }
  fs.mkdirSync(path.join(dir, "config"));
  fs.writeFileSync(path.join(dir, "config", "staging.env"), "x");

  const { entries, excluded } = selectFiles(dir);
  const uploaded = entries.map((entry) => entry.relative).sort();

  assert.deepEqual(uploaded, ["env.json", "environment.js", "index.html"]);
  for (const name of [...secrets, "config/staging.env"]) {
    assert.ok(excluded.includes(name), `${name} should be reported as excluded`);
  }
});

// TGL-1167: `.npmrc` (a registry token) and `id_rsa` (a private key) were
// published, because only env files were excluded.
test("credential files are never uploaded, and are reported by name", async () => {
  const { selectFiles } = await import("../build/deploy-static/manifest.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-site-"));
  const secrets = [
    ".npmrc", ".yarnrc.yml", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", ".dev.vars",
    "id_rsa", "id_rsa.pub", "id_ed25519", "server.pem", "tls.key", "cert.p12", "credentials.json",
    "service-account-prod.json", ".pgpass",
  ];
  for (const name of [...secrets, "index.html", "key.js", "keys.html"]) {
    fs.writeFileSync(path.join(dir, name), "x");
  }
  for (const sub of [".ssh", ".aws", ".docker", ".well-known", "assets"]) {
    fs.mkdirSync(path.join(dir, sub));
  }
  fs.writeFileSync(path.join(dir, ".ssh", "id_rsa"), "x");
  fs.writeFileSync(path.join(dir, ".aws", "credentials"), "x");
  fs.writeFileSync(path.join(dir, ".docker", "config.json"), "x");
  fs.writeFileSync(path.join(dir, ".well-known", "security.txt"), "x");
  fs.writeFileSync(path.join(dir, "assets", "deploy.key"), "x");

  const { entries, secrets: flagged } = selectFiles(dir);
  const uploaded = entries.map((entry) => entry.relative).sort();
  assert.deepEqual(uploaded, [".well-known/security.txt", "index.html", "key.js", "keys.html"]);
  for (const name of [...secrets, ".ssh/", ".aws/", ".docker/", "assets/deploy.key"]) {
    assert.ok(flagged.includes(name), `${name} should be reported as a credential`);
  }
});

test(".naijacloudignore and manifest ignore use .gitignore syntax, and cannot re-include a secret", async () => {
  const { selectFiles } = await import("../build/deploy-static/manifest.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-site-"));
  for (const name of ["index.html", "notes.md", "README.md", ".npmrc", "draft.html"]) {
    fs.writeFileSync(path.join(dir, name), "x");
  }
  fs.mkdirSync(path.join(dir, "private"));
  fs.writeFileSync(path.join(dir, "private", "a.html"), "x");
  fs.writeFileSync(
    path.join(dir, ".naijacloudignore"),
    "# comment\n*.md\n!README.md\n/private/\n!.npmrc\n",
  );

  const { entries, ignored } = selectFiles(dir, ["draft.html"]);
  const uploaded = entries.map((entry) => entry.relative).sort();
  assert.deepEqual(uploaded, ["README.md", "index.html"]);
  assert.deepEqual(ignored.sort(), ["draft.html", "notes.md", "private"]);
});

test("a .naijacloudignore beside naijacloud.json applies to a dist/ subdirectory", async () => {
  const { selectFiles } = await import("../build/deploy-static/manifest.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nc-site-"));
  fs.mkdirSync(path.join(dir, "maps"));
  fs.writeFileSync(path.join(dir, "index.html"), "x");
  fs.writeFileSync(path.join(dir, "maps", "app.js.map"), "x");
  const { entries } = selectFiles(dir, [], [{ patterns: ["dist/maps/"], base: "dist" }]);
  assert.deepEqual(entries.map((entry) => entry.relative), ["index.html"]);
});
