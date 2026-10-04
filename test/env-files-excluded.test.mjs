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
