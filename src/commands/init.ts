/**
 * `naijacloud init` — write a `naijacloud.json` without deploying.
 *
 * Nobody strictly needs this: a first `naijacloud deploy` asks the same
 * questions and writes the same file. It exists for the cases where writing the
 * config and shipping the site are separate acts — setting a repo up for CI
 * before the build works, reviewing the manifest in a pull request, or
 * committing the file from a machine that has no credentials.
 *
 * The one thing it deliberately cannot do is invent a `serviceId`: that only
 * exists once a deploy has actually created a site, so the manifest this writes
 * is always "create a new site on the next deploy" — unless one is already
 * there, in which case it is carried over untouched.
 */

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

import { askManifestBasics } from "../deploy-static/configure.js";
import { askEnvironment } from "../deploy-static/target.js";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  detectLocal,
  readManifest,
  writeManifest,
} from "../deploy-static/manifest.js";
import type { Manifest } from "../deploy-static/manifest.js";
import { programName } from "../program-name.js";
import { resolveEnvironmentId } from "./resolve.js";
import { CancelledError, isInteractive, requireTty, write } from "../terminal.js";
import { refreshLinkedLocalSchema, remoteSchemaUrl } from "./schema.js";

export interface InitOptions {
  /** Positional argument: directory to initialise. Defaults to the cwd. */
  dir: string | undefined;
  name: string | undefined;
  output: string | undefined;
  index: string | undefined;
  spa: boolean | undefined;
  /** Accept every detected default instead of prompting. */
  yes: boolean;
  /** Rewrite an existing manifest. */
  force: boolean;
  /** Environment the site will be created in, as an id or `project/environment`. */
  env: string | undefined;
  json: boolean;
}

export async function init(options: InitOptions): Promise<void> {
  const root = resolve(process.cwd(), options.dir ?? ".");
  const manifestPath = join(root, MANIFEST_FILENAME);

  // Only the manifest in *this* directory counts. Unlike deploy, init does not
  // walk up: initialising a subdirectory that inherits a parent's manifest is a
  // reasonable thing to want, and silently editing the parent would not be.
  const existing = existsSync(manifestPath) ? readManifest(manifestPath) : null;

  if (existing && !options.force) {
    throw new Error(
      `${relative(process.cwd(), manifestPath) || MANIFEST_FILENAME} already exists. ` +
        "Edit it directly, or re-run with --force to rewrite it.",
    );
  }

  const interactive = !options.yes && isInteractive();
  if (!interactive && !options.yes) {
    requireTty("Writing a manifest", [
      `${programName()} init --name <name> --output <dir> --yes`,
    ]);
  }

  const detected = detectLocal(root);

  if (interactive) {
    write(
      existing
        ? `Rewriting ${MANIFEST_FILENAME} — current values are the defaults.\n\n`
        : `Setting up ${MANIFEST_FILENAME} in ${relative(process.cwd(), root) || "."}\n\n`,
    );
  }

  // An existing manifest's values become the *defaults* rather than settled
  // answers, so `--force` is an edit with everything pre-filled — not a reset,
  // and not a set of questions that skip themselves. Only flags settle a value
  // outright.
  const previous: Manifest = existing?.manifest ?? {};
  const answers = await askManifestBasics(
    {
      name: previous.name ?? detected.name,
      build: previous.build ?? detected.build,
      output: previous.output ?? detected.output,
      spa: previous.spa ?? detected.spa,
      framework: detected.framework,
    },
    {
      interactive,
      name: options.name,
      output: options.output,
      spa: options.spa,
      askBuild: true,
    },
  );

  // Same question the first deploy asks, so the two cannot drift. An explicit
  // --env is resolved eagerly, which turns a typo'd environment into an error
  // here rather than at the first deploy.
  const settled =
    options.env !== undefined
      ? await resolveEnvironmentId(options.env)
      : previous.environmentId;
  const target = await askEnvironment({ interactive, settled });
  if (target.cancelled) throw new CancelledError();

  const manifest: Manifest = { ...previous };
  manifest.$schema = previous.$schema ?? remoteSchemaUrl();
  manifest.version = previous.version ?? MANIFEST_VERSION;
  manifest.name = answers.name;
  manifest.output = answers.output;
  manifest.spa = answers.spa;
  if (answers.build !== undefined) manifest.build = answers.build;
  else delete manifest.build;

  if (target.environmentId !== undefined) manifest.environmentId = target.environmentId;

  const index = options.index ?? previous.index;
  if (index !== undefined) manifest.index = index;

  writeManifest(manifestPath, manifest);
  refreshLinkedLocalSchema(root, manifest);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, manifest: manifestPath, values: manifest }, null, 2)}\n`,
    );
    return;
  }

  if (interactive) write("\n");
  process.stdout.write(`${manifestPath}\n`);
  write(
    `Wrote ${MANIFEST_FILENAME}\n` +
      (manifest.serviceId === undefined
        ? `Run \`${programName()} deploy\` to create the site; the id it returns is written back here.\n`
        : `Run \`${programName()} deploy\` to update the existing site.\n`),
  );
}
