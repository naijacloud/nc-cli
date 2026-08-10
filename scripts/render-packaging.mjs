#!/usr/bin/env node
/**
 * Renders every package manifest from packaging/templates/, filling in the
 * version, the release URLs and the real SHA-256 of each artifact.
 *
 * Checksums are read from the release's `checksums.txt` rather than recomputed,
 * so a manifest can only ever describe files that were actually published —
 * a formula pointing at a hash nobody uploaded is the classic packaging bug.
 *
 * Usage:
 *   node scripts/render-packaging.mjs --checksums dist-bin/naijacloud_0.1.0_checksums.txt
 *   node scripts/render-packaging.mjs --checksums <file> --out dist-packaging
 *
 * Then commit the output into the tap / bucket / winget-pkgs fork.
 */

import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function flag(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const version = flag("version", pkg.version);
const outDir = resolve(root, flag("out", "dist-packaging"));
const repoSlug = process.env["NAIJACLOUD_REPO_SLUG"] ?? "naijacloud/nc-cli";
const releaseBase = `https://github.com/${repoSlug}/releases/download/v${version}`;

/* -------------------------------------------------------------------------- */
/* Checksums                                                                  */
/* -------------------------------------------------------------------------- */

const checksumsPath = flag("checksums", join(root, "dist-bin", `naijacloud_${version}_checksums.txt`));

/**
 * Parses `sha256sum` output: "<hash>  <filename>", one per line. Filenames may
 * carry a directory prefix depending on where the tool ran, so only the
 * basename is matched.
 */
function readChecksums(path) {
  const map = new Map();
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(
      `No checksums file at ${path}. Build the artifacts first, then:\n` +
        `  (cd dist-bin && shasum -a 256 *.tar.gz *.zip > naijacloud_${version}_checksums.txt)`,
    );
  }

  for (const line of text.split("\n")) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (!match) continue;
    const [, hash, file] = match;
    map.set(file.replace(/^.*[/\\]/, ""), hash.toLowerCase());
  }
  return map;
}

const checksums = readChecksums(checksumsPath);

/** Looks up one artifact, failing loudly rather than rendering an empty hash. */
function hashOf(target, extension) {
  const filename = `naijacloud_${version}_${target}.${extension}`;
  const hash = checksums.get(filename);
  if (!hash) {
    throw new Error(
      `${checksumsPath} has no entry for ${filename}. ` +
        "Every platform in the matrix must finish before manifests are rendered.",
    );
  }
  return hash;
}

/* -------------------------------------------------------------------------- */
/* Substitutions                                                              */
/* -------------------------------------------------------------------------- */

const values = {
  VERSION: version,
  REPO_SLUG: repoSlug,
  RELEASE_BASE: releaseBase,
  RELEASE_DATE: new Date().toISOString().slice(0, 10),
  SHA256_DARWIN_ARM64: hashOf("darwin_arm64", "tar.gz"),
  SHA256_DARWIN_AMD64: hashOf("darwin_amd64", "tar.gz"),
  SHA256_LINUX_ARM64: hashOf("linux_arm64", "tar.gz"),
  SHA256_LINUX_AMD64: hashOf("linux_amd64", "tar.gz"),
  SHA256_WINDOWS_AMD64: hashOf("windows_amd64", "zip"),
};

function render(text) {
  return text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Template uses unknown placeholder ${match}.`);
    return value;
  });
}

/* -------------------------------------------------------------------------- */
/* Walk the templates                                                         */
/* -------------------------------------------------------------------------- */

const templatesDir = join(root, "packaging", "templates");
const rendered = [];

function walk(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true });
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    const from = join(fromDir, entry.name);
    const to = join(toDir, entry.name);
    if (entry.isDirectory()) {
      walk(from, to);
      continue;
    }
    writeFileSync(to, render(readFileSync(from, "utf8")), "utf8");
    rendered.push(to.slice(outDir.length + 1));
  }
}

walk(templatesDir, outDir);

// nfpm reads its config directly (it expands ${VERSION} / ${ARCH} itself), so
// it is copied rather than rendered — one less place for the two to disagree.
copyFileSync(join(root, "packaging", "nfpm.yaml"), join(outDir, "nfpm.yaml"));
rendered.push("nfpm.yaml");

process.stderr.write(`Rendered for v${version} → ${outDir}\n`);
for (const file of rendered.sort()) process.stderr.write(`  ${file}\n`);
