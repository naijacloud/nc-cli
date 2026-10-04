/**
 * `naijacloud.json` — the per-directory deploy manifest.
 *
 * The CLI owns this file: `naijacloud deploy` reads it when it exists, and
 * writes it after a first successful deploy so every later run is
 * argument-free. Nobody is expected to hand-write one.
 *
 * The zod schema below is the single source of truth. It validates the file at
 * read time, and `npm run build` converts the same object into
 * `schema/naijacloud.schema.json` via `z.toJSONSchema()` — so the published
 * JSON Schema cannot drift from the validator, because it *is* the validator.
 *
 * Three rules keep the format cheap to extend:
 *
 *   1. Additive only — new capabilities arrive as new keys, existing keys never
 *      change meaning, and `version` is bumped only for a real break.
 *   2. Unknown keys warn, never fail (hence `looseObject`), so an older CLI can
 *      still deploy a repo whose manifest a newer CLI wrote.
 *   3. No secrets. The file is committed and sits next to the build output;
 *      credentials belong in env vars on the service.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse as parsePath, resolve } from "node:path";

import { z } from "zod";

export const MANIFEST_FILENAME = "naijacloud.json";

/** Current manifest format. Bumped only by a breaking change, never by new keys. */
export const MANIFEST_VERSION = 1;

/** Directory for generated, per-user state. Self-ignoring; never committed. */
export const STATE_DIR = ".naijacloud";

/** Where `--write` puts the editor copy of the JSON Schema, relative to the manifest. */
export const LOCAL_SCHEMA_PATH = `${STATE_DIR}/schema.json`;

/* -------------------------------------------------------------------------- */
/* Schema                                                                     */
/* -------------------------------------------------------------------------- */

export const manifestSchema = z
  .looseObject({
    $schema: z
      .string()
      .optional()
      .describe(
        "JSON Schema for editor completion — by default the hosted copy for the CLI " +
          "version that wrote this file. `naijacloud schema --write` swaps it for a " +
          `local copy at ${LOCAL_SCHEMA_PATH}, for editors with no network access.`,
      ),
    version: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Manifest format version. Currently 1."),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Site name, used for the generated *.naijacloud.com subdomain. Applies to the " +
          "first deploy only — renaming later is a dashboard operation.",
      ),
    serviceId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "The site this directory deploys to, written by the first successful deploy. " +
          "Its presence is what makes a deploy a redeploy: same site, same URL, " +
          "atomic cutover.",
      ),
    environmentId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Environment this site is created in, e.g. the project's 'prod'. Services " +
          "belong to an environment, not directly to a project, and which one they " +
          "are in is what makes a deploy production. Written back by the first " +
          "deploy that targets one; without it the platform places the site itself.",
      ),
    build: z
      .string()
      .optional()
      .describe(
        "Command run locally before the output directory is archived, e.g. " +
          "'npm run build'. A non-zero exit aborts the deploy before anything is " +
          "uploaded. Skipped by --prebuilt.",
      ),
    output: z
      .string()
      .optional()
      .describe(
        "Directory whose contents are deployed, relative to this file — e.g. 'dist'. " +
          "May also be a single .html file.",
      ),
    spa: z
      .boolean()
      .optional()
      .describe(
        "Serve the index file for unmatched paths, so client-side routes survive a " +
          "hard refresh. True for single-page apps, false for multi-page static sites.",
      ),
    index: z
      .string()
      .optional()
      .describe("Entry file, when it is not index.html."),
    ignore: z
      .array(z.string())
      .optional()
      .describe(
        "Glob patterns excluded from the archive, on top of the always-excluded set " +
          "(.git, node_modules, .naijacloud, .env files).",
      ),
  })
  .describe(
    "Deploy manifest for the NaijaCloud CLI. Written by `naijacloud deploy`; commit it.",
  );

export type Manifest = z.infer<typeof manifestSchema>;

/** Keys this CLI version understands, in the order they are written out. */
const KNOWN_KEYS = [
  "$schema",
  "version",
  "name",
  "serviceId",
  "environmentId",
  "build",
  "output",
  "spa",
  "index",
  "ignore",
] as const;

/* -------------------------------------------------------------------------- */
/* Read / write                                                               */
/* -------------------------------------------------------------------------- */

export interface LoadedManifest {
  /** Absolute path to the manifest file. */
  path: string;
  /** Directory the manifest lives in — all relative paths resolve against it. */
  dir: string;
  manifest: Manifest;
  /** Keys this CLI does not know about; reported, then preserved on write. */
  unknownKeys: string[];
}

/**
 * Walks up from `startDir` looking for a manifest, so `naijacloud deploy` works
 * from a subdirectory the way git does. Stops at a repository root (a directory
 * containing `.git`) and at the filesystem root.
 */
export function findManifest(startDir: string): string | null {
  let dir = resolve(startDir);
  const { root } = parsePath(dir);

  for (;;) {
    const candidate = join(dir, MANIFEST_FILENAME);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, ".git"))) return null;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

/** Parses and validates a manifest, reporting any keys this version ignores. */
export function readManifest(path: string): LoadedManifest {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read ${path} (${reason}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`${path} is not valid JSON (${reason}).`);
  }

  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${path} is not a valid manifest:\n${problems}`);
  }

  const unknownKeys = Object.keys(result.data).filter(
    (key) => !(KNOWN_KEYS as readonly string[]).includes(key),
  );

  return { path, dir: dirname(path), manifest: result.data, unknownKeys };
}

/**
 * Writes the manifest with a stable key order, unknown keys preserved at the
 * end. Rule 2 above cuts both ways: a newer CLI's keys survive a write by an
 * older one.
 */
export function writeManifest(path: string, manifest: Manifest): void {
  const ordered: Record<string, unknown> = {};
  for (const key of KNOWN_KEYS) {
    const value = manifest[key];
    if (value !== undefined) ordered[key] = value;
  }
  for (const [key, value] of Object.entries(manifest)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }

  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Local detection                                                            */
/* -------------------------------------------------------------------------- */

export interface Detected {
  name: string;
  build: string | undefined;
  output: string | undefined;
  spa: boolean;
  /** Framework label for the prompt's "(detected: …)" hint. */
  framework: string | undefined;
}

/** Output directories to probe, in the order a build tool would produce them. */
const OUTPUT_CANDIDATES = ["dist", "build", "out", "public", "_site", "www"];

/** package.json dependency → framework label and whether it is a single-page app. */
const FRAMEWORKS: { dep: string; label: string; spa: boolean }[] = [
  // Routers are the strongest signal: they exist precisely because the app
  // resolves paths on the client.
  { dep: "react-router-dom", label: "React Router", spa: true },
  { dep: "vue-router", label: "Vue Router", spa: true },
  { dep: "@angular/core", label: "Angular", spa: true },
  { dep: "@sveltejs/kit", label: "SvelteKit", spa: false },
  { dep: "svelte", label: "Svelte", spa: true },
  { dep: "react-scripts", label: "Create React App", spa: true },
  { dep: "solid-js", label: "Solid", spa: true },
  // Site generators emit one HTML file per route, so a fallback would mask 404s.
  { dep: "astro", label: "Astro", spa: false },
  { dep: "@11ty/eleventy", label: "Eleventy", spa: false },
  { dep: "gatsby", label: "Gatsby", spa: false },
  { dep: "@docusaurus/core", label: "Docusaurus", spa: false },
  { dep: "vitepress", label: "VitePress", spa: false },
  { dep: "nuxt", label: "Nuxt", spa: false },
  { dep: "vue", label: "Vue", spa: true },
  { dep: "vite", label: "Vite", spa: true },
  { dep: "react", label: "React", spa: true },
];

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  packageManager?: string;
}

function readPackageJson(dir: string): PackageJson | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
  } catch {
    return null;
  }
}

/**
 * Picks the package manager from the lockfile actually in the directory, so the
 * build command matches how the project is installed.
 */
function packageManagerFor(dir: string): string {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  return "npm";
}

/** Lowercases and strips a directory name down to something usable as a subdomain. */
export function sanitizeName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return cleaned || "site";
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when a directory holds an `index.html` — i.e. it is already deployable. */
function looksStatic(dir: string): boolean {
  return existsSync(join(dir, "index.html")) || existsSync(join(dir, "index.htm"));
}

/**
 * Infers the manifest's defaults from the directory itself.
 *
 * Deliberately local and offline. The server-side `detectBuild` query inspects a
 * *connected repository* (it takes gitUrl / repoFullName / branch), so it cannot
 * see an uncommitted working directory and is the wrong tool for this path —
 * it belongs to the repo-connected service flows instead.
 */
export function detectLocal(dir: string): Detected {
  const pkg = readPackageJson(dir);
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };

  const framework = FRAMEWORKS.find((entry) => entry.dep in deps);

  const build =
    pkg?.scripts?.["build"] !== undefined
      ? `${packageManagerFor(dir)} run build`
      : undefined;

  // An already-built directory (index.html at the top) is its own output; that
  // covers hand-written sites and `naijacloud deploy ./dist` with no tooling.
  let output: string | undefined;
  if (build === undefined && looksStatic(dir)) {
    output = ".";
  } else {
    output = OUTPUT_CANDIDATES.find((candidate) => isDirectory(join(dir, candidate)));
    // Nothing built yet: name the directory the build script will create rather
    // than leaving the prompt blank.
    if (output === undefined && build !== undefined) {
      output = framework?.label === "Create React App" ? "build" : "dist";
    }
  }

  return {
    name: sanitizeName(pkg?.name ?? basename(resolve(dir))),
    build,
    output,
    spa: framework?.spa ?? false,
    framework: framework?.label,
  };
}

/* -------------------------------------------------------------------------- */
/* Archive selection                                                          */
/* -------------------------------------------------------------------------- */

/** Paths never uploaded, whatever `ignore` says. */
const ALWAYS_EXCLUDED = new Set([".git", "node_modules", STATE_DIR, MANIFEST_FILENAME]);

/**
 * Secrets must never reach a public CDN, and a static bundle is world-readable
 * by definition, so `.env` files are dropped unconditionally rather than warned
 * about.
 *
 * That means every naming in use, not only the dotfile: `.env` and `.env.local`,
 * but also `production.env` / `db.env` (Docker's `env_file` convention) and
 * direnv's `.envrc`. A site has no reason to serve any of them.
 */
export function isEnvFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".env") ||
    lower === ".envrc"
  );
}

/** One file selected for the archive. */
export interface ArchiveEntry {
  /** Absolute path on disk. */
  absolute: string;
  /** Forward-slashed path inside the archive. */
  relative: string;
  size: number;
}

export interface ArchiveSelection {
  entries: ArchiveEntry[];
  /** Paths dropped by the always-excluded rules, for the "skipped" notice. */
  excluded: string[];
}

/**
 * Translates one ignore pattern into a regular expression.
 *
 * Supports the subset people actually write in this file: `*` (within a path
 * segment), `**` (across segments), `?`, and a trailing `/` meaning "this
 * directory and everything under it". A pattern with no slash matches by
 * basename anywhere in the tree, the way .gitignore behaves.
 */
function patternToRegExp(pattern: string): { test: (relative: string) => boolean } {
  const trimmed = pattern.replace(/^\.\//, "");
  // A trailing slash only says "directory"; the subtree suffix below covers it.
  const body = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  const byBasename = !body.includes("/");

  let source = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "*") {
      if (body[index + 1] === "*") {
        source += ".*";
        index += 1;
        // Swallow the slash in `**/` so it can also match zero segments.
        if (body[index + 1] === "/") index += 1;
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += (char ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }

  // The trailing `(/.*)?` is what makes a matched directory take its subtree
  // with it — `coverage/` and `coverage` both drop everything underneath.
  const anchored = new RegExp(`^${source}(/.*)?$`);
  return {
    test: (relative: string): boolean =>
      anchored.test(relative) ||
      (byBasename && relative.split("/").some((segment) => anchored.test(segment))),
  };
}

/**
 * Walks the output directory and returns everything that should be archived.
 * Symlinks are followed for files but not for directories, so a link out of the
 * tree cannot smuggle in an unbounded subtree.
 */
export function selectFiles(root: string, ignore: string[] = []): ArchiveSelection {
  const matchers = ignore.map(patternToRegExp);
  const entries: ArchiveEntry[] = [];
  const excluded: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Cannot read ${dir} (${reason}).`);
    }

    for (const name of names) {
      const relative = prefix ? `${prefix}/${name}` : name;

      if (ALWAYS_EXCLUDED.has(name) || isEnvFile(name)) {
        excluded.push(relative);
        continue;
      }
      if (matchers.some((matcher) => matcher.test(relative))) continue;

      const absolute = join(dir, name);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        continue; // A dangling symlink is not worth failing a deploy over.
      }

      if (stats.isDirectory()) {
        walk(absolute, relative);
      } else if (stats.isFile()) {
        entries.push({ absolute, relative, size: stats.size });
      }
    }
  };

  walk(resolve(root), "");
  return { entries, excluded };
}
