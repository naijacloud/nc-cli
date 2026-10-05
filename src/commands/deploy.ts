/**
 * `naijacloud deploy` — build, archive, upload, release.
 *
 * The pipeline mirrors what the platform expects (see the static-site
 * operations in api-client.ts):
 *
 *   1. run the manifest's build command, if any
 *   2. archive the output directory (or take a single .html as-is)
 *   3. ask for a presigned upload slot — the size is bound into its signature,
 *      so the archive must be final first
 *   4. PUT the bytes straight to storage
 *   5. `deployStaticSite` for a new site, `redeployStaticSite` when the manifest
 *      already names one
 *   6. poll the deployment to a terminal state
 *
 * Configuration comes from `naijacloud.json`, and when that file is missing the
 * command asks instead — then writes the answers out, so this is the only run
 * that ever asks. Resolution order, highest first: flags, environment,
 * manifest, local detection, prompt.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import process from "node:process";

import {
  createStaticService,
  createStaticUpload,
  deployStaticSite,
  getStaticSite,
  listDeploymentsByService,
  redeployStaticSite,
  siteUrl,
  uploadToPresigned,
} from "../api/index.js";
import type { DeploymentStatus, StaticSite } from "../api/index.js";
import {
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  detectLocal,
  findManifest,
  readManifest,
  selectFiles,
  writeManifest,
} from "../deploy-static/manifest.js";
import type { Manifest } from "../deploy-static/manifest.js";
import { askManifestBasics } from "../deploy-static/configure.js";
import { askEnvironment } from "../deploy-static/target.js";
import { programName } from "../program-name.js";
import { resolveEnvironmentId } from "./resolve.js";
import { CancelledError, isInteractive, requireTty, write } from "../terminal.js";
import { refreshLinkedLocalSchema, remoteSchemaUrl } from "./schema.js";
import { waitForDeployment } from "./wait.js";
import { createZip } from "../deploy-static/zip.js";

export interface DeployOptions {
  /** Positional argument: the directory (or .html file) to deploy. */
  dir: string | undefined;
  name: string | undefined;
  output: string | undefined;
  index: string | undefined;
  spa: boolean | undefined;
  /** Skip the manifest's build command — the output is already built. */
  prebuilt: boolean;
  /** Create a new site even when the manifest already names one. */
  createNew: boolean;
  /** Environment to create the site in, as an id or `project/environment`. */
  env: string | undefined;
  /** Accept every detected default instead of prompting. */
  yes: boolean;
  json: boolean;
  /** Wait for the deployment to reach a terminal state. */
  wait: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

interface ResolvedConfig {
  /** Directory the manifest lives in (or would live in). */
  root: string;
  manifestPath: string;
  /** Manifest as loaded, or an empty one for a first run. */
  manifest: Manifest;
  /** True when there was no manifest on disk. */
  isFirstRun: boolean;
  name: string;
  output: string;
  build: string | undefined;
  spa: boolean;
  index: string | undefined;
  ignore: string[];
  serviceId: string | undefined;
  /** Environment to create the site in. Undefined lets the platform place it. */
  environmentId: string | undefined;
}

function envValue(key: string): string | undefined {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
}

/**
 * Merges every configuration source, asking the user only for what is still
 * unknown after the rest have had their say.
 */
async function resolveConfig(options: DeployOptions): Promise<ResolvedConfig> {
  const cwd = process.cwd();
  const found = findManifest(cwd);
  const loaded = found ? readManifest(found) : null;

  if (loaded && loaded.unknownKeys.length > 0) {
    // Rule 2 of the format: tolerate what a newer CLI wrote, say so, carry on.
    write(
      `Note: ${MANIFEST_FILENAME} has keys this version does not understand ` +
        `(${loaded.unknownKeys.join(", ")}). They are ignored and preserved.\n`,
    );
  }

  const root = loaded?.dir ?? cwd;
  const manifest: Manifest = loaded?.manifest ?? {};

  // An explicit path argument names what to deploy; it is the output override.
  const positional = options.dir;

  let name = options.name ?? envValue("NAIJACLOUD_NAME") ?? manifest.name;
  let output = positional ?? options.output ?? envValue("NAIJACLOUD_OUTPUT") ?? manifest.output;
  let spa = options.spa ?? manifest.spa;
  const index = options.index ?? manifest.index;
  const build = manifest.build;
  const ignore = manifest.ignore ?? [];
  const serviceId = options.createNew
    ? undefined
    : envValue("NAIJACLOUD_SERVICE_ID") ?? manifest.serviceId;

  // Only consulted when creating a site; a redeploy goes to whichever
  // environment the existing service already lives in.
  const environmentRef =
    options.env ?? envValue("NAIJACLOUD_ENVIRONMENT_ID") ?? manifest.environmentId;
  let environmentId =
    environmentRef === undefined || serviceId !== undefined
      ? undefined
      : await resolveEnvironmentId(environmentRef);

  const detected = detectLocal(root);

  // A first run creates a *new site*. Doing that silently in CI would mint a
  // fresh site on every build, so a non-interactive first run has to be explicit
  // — `--yes` is how the caller says "use what you detect".
  if (loaded === null && serviceId === undefined && !options.yes) {
    requireTty("Configuring a first deploy", [
      `${programName()} deploy <dir> --name <name> --yes`,
      `or commit a ${MANIFEST_FILENAME} (write one with '${programName()} schema --write')`,
    ]);
  }

  const interactive = !options.yes && isInteractive() && loaded === null;

  if (interactive) {
    write(
      `No ${MANIFEST_FILENAME} here — a few questions, then this is the last time.\n\n`,
    );
  }

  // The same questions `naijacloud init` asks — a first deploy is an init that
  // also ships the site. A build command already in the manifest is settled; an
  // explicit path argument means the caller handed us built output, so there is
  // nothing to build either.
  const answers = await askManifestBasics(detected, {
    interactive,
    name,
    build,
    output,
    spa,
    askBuild: loaded === null && positional === undefined,
  });

  name = answers.name;
  output = answers.output;
  spa = answers.spa;
  const chosenBuild = answers.build;

  // Asked last, and only when creating: it is the "where" after the "what", and
  // a redeploy already has an answer it cannot change.
  if (serviceId === undefined) {
    const target = await askEnvironment({
      interactive,
      settled: environmentId,
    });
    if (target.cancelled) throw new CancelledError();
    environmentId = target.environmentId;
  }

  if (interactive) write("\n");

  const config: ResolvedConfig = {
    root,
    manifestPath: found ?? join(root, MANIFEST_FILENAME),
    manifest,
    isFirstRun: loaded === null,
    name,
    output,
    build: chosenBuild,
    spa,
    index,
    ignore,
    serviceId,
    environmentId,
  };
  return config;
}

/* -------------------------------------------------------------------------- */
/* Build and archive                                                          */
/* -------------------------------------------------------------------------- */

/** Runs the build command with its output attached to the user's terminal. */
function runBuild(command: string, cwd: string): void {
  write(`Running \`${command}\`\n`);
  const result = spawnSync(command, {
    cwd,
    shell: true,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(`Could not run the build command (${result.error.message}).`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Build command failed with exit code ${result.status ?? "unknown"}. Nothing was uploaded.`,
    );
  }
}

interface Bundle {
  body: Buffer;
  filename: string;
  contentType: string;
  fileCount: number;
  /** Human summary of what went in, for the progress line. */
  description: string;
}

/**
 * Turns the output path into the bytes to upload: a single .html file goes up
 * as-is (the platform serves it directly), anything else is zipped.
 */
function buildBundle(config: ResolvedConfig): Bundle {
  const target = resolve(config.root, config.output);

  if (!existsSync(target)) {
    const hint = config.build
      ? `Did the build command produce it? Run \`${config.build}\` and check its output directory.`
      : "Point --output at the directory to deploy.";
    throw new Error(`Output path ${relative(config.root, target) || target} does not exist. ${hint}`);
  }

  if (statSync(target).isFile()) {
    if (!/\.html?$/i.test(target)) {
      throw new Error(
        `${basename(target)} is not a directory or an .html file, so there is nothing to serve.`,
      );
    }
    const body = readFileSync(target);
    return {
      body,
      filename: basename(target),
      contentType: "text/html",
      fileCount: 1,
      description: `${basename(target)} (${formatBytes(body.length)})`,
    };
  }

  const { entries, excluded } = selectFiles(target, config.ignore);
  if (entries.length === 0) {
    throw new Error(`${relative(config.root, target) || target} is empty — nothing to deploy.`);
  }

  if (excluded.length > 0) {
    // Secrets are dropped unconditionally, so say which ones: silence here would
    // look like the file was uploaded.
    write(`Skipped ${excluded.length} excluded path(s): ${excluded.slice(0, 5).join(", ")}\n`);
  }

  const entryName = config.index ?? "index.html";
  if (!entries.some((entry) => entry.relative === entryName)) {
    write(`Warning: no ${entryName} at the top of ${config.output} — the site may 404.\n`);
  }

  const { buffer, uncompressedBytes } = createZip(
    entries.map((entry) => ({ path: entry.relative, contents: readFileSync(entry.absolute) })),
  );

  return {
    body: buffer,
    filename: `${config.name}.zip`,
    contentType: "application/zip",
    fileCount: entries.length,
    description:
      `${entries.length} file${entries.length === 1 ? "" : "s"}, ` +
      `${formatBytes(uncompressedBytes)} → ${formatBytes(buffer.length)} compressed`,
  };
}

/* -------------------------------------------------------------------------- */
/* Command                                                                    */
/* -------------------------------------------------------------------------- */

export async function deploy(options: DeployOptions): Promise<void> {
  const config = await resolveConfig(options);

  if (config.build !== undefined && !options.prebuilt) {
    runBuild(config.build, config.root);
  }

  const bundle = buildBundle(config);
  write(`Packaged ${bundle.description}\n`);

  const slot = await createStaticUpload({
    filename: bundle.filename,
    contentType: bundle.contentType,
    sizeBytes: bundle.body.length,
  });

  if (bundle.body.length > slot.maxBytes) {
    throw new Error(
      `The bundle is ${formatBytes(bundle.body.length)}, over the ` +
        `${formatBytes(slot.maxBytes)} upload limit. Trim the output directory, or add ` +
        "large assets to `ignore` and serve them from object storage.",
    );
  }

  write(`Uploading ${formatBytes(bundle.body.length)}\n`);
  await uploadToPresigned(slot, bundle.body);

  let site: StaticSite | null = null;
  let deploymentId: string;
  let status: DeploymentStatus;
  const created = config.serviceId === undefined;

  if (config.serviceId === undefined && config.environmentId !== undefined) {
    // Environment-targeted creation. `deployStaticSite` cannot do this — its
    // input carries no environmentId, so it always lands wherever the platform
    // decides. `createService` is the only mutation that places a static site
    // in a chosen environment, which is what makes a static site an ordinary
    // member of the project tree rather than an orphan beside it.
    const input: Parameters<typeof createStaticService>[0] = {
      environmentId: config.environmentId,
      name: config.name,
      staticUploadId: slot.uploadId,
      staticSpa: config.spa,
    };
    if (config.index !== undefined) input.staticIndexPath = config.index;

    const service = await createStaticService(input);
    // createService returns the service, not a deployment, so the first build
    // has to be located rather than handed over.
    const first = (await listDeploymentsByService(service.id))[0];
    if (!first) {
      throw new Error(
        `Created ${service.name}, but no build was queued for it. Check the ` +
          "dashboard before deploying again.",
      );
    }
    deploymentId = first.id;
    status = first.status;
    site = await getStaticSite(service.id);
    write(`Created site ${service.name} in the target environment\n`);
  } else if (config.serviceId === undefined) {
    const input: Parameters<typeof deployStaticSite>[0] = {
      uploadId: slot.uploadId,
      name: config.name,
      spaFallback: config.spa,
    };
    if (config.index !== undefined) input.indexPath = config.index;

    const result = await deployStaticSite(input);
    site = result.site;
    deploymentId = result.deployment.id;
    status = result.deployment.status;
    write(`Created site ${site.name}\n`);
  } else {
    const input: Parameters<typeof redeployStaticSite>[0] = {
      serviceId: config.serviceId,
      uploadId: slot.uploadId,
      spaFallback: config.spa,
    };
    if (config.index !== undefined) input.indexPath = config.index;

    const deployment = await redeployStaticSite(input);
    deploymentId = deployment.id;
    status = deployment.status;
    write(`Redeploying site ${config.serviceId}\n`);
  }

  const serviceId = site?.id ?? config.serviceId!;
  let failure: string | null = null;

  if (options.wait) {
    const settled = await waitForDeployment(deploymentId, status);
    status = settled.status;
    if (status !== "RUNNING") failure = settled.error;
  }

  // Re-read the site once the deploy has landed: `url` is null on a freshly
  // created site and only fills in when the first build goes live.
  if (status === "RUNNING" || site === null) {
    try {
      site = await getStaticSite(serviceId);
    } catch {
      // A read failure here must not lose the deploy that already succeeded.
    }
  }

  const url = siteUrl(site);
  const manifestWritten = persistManifest(config, serviceId);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: status === "RUNNING" || !options.wait,
          created,
          siteId: serviceId,
          name: site?.name ?? config.name,
          url,
          deploymentId,
          status,
          error: failure,
          files: bundle.fileCount,
          bytes: bundle.body.length,
          manifest: manifestWritten ? config.manifestPath : null,
        },
        null,
        2,
      )}\n`,
    );
  }

  if (status === "FAILED" || status === "CANCELLED") {
    throw new Error(
      `Deployment ${deploymentId} ended as ${status}${failure ? `: ${failure}` : "."} ` +
        "The previous version, if any, is still serving.",
    );
  }

  if (!options.json) {
    if (url) process.stdout.write(`${url}\n`);
    if (!options.wait) {
      write(`Deployment ${deploymentId} queued; not waiting (--no-wait).\n`);
    }
    if (manifestWritten) {
      write(`Wrote ${MANIFEST_FILENAME}\n`);
      write(
        created
          ? // Without the committed serviceId, the next run has no way to know
            // this site exists and would create a second one.
            `Commit it — that is what makes the next deploy update this site ` +
              "instead of creating another.\n"
          : `Next time, just \`${programName()} deploy\`.\n`,
      );
    }
  }
}

/**
 * Writes the manifest once the deploy has actually worked — a failed first
 * attempt should not leave a half-configured repo behind. Returns true when the
 * file changed.
 */
function persistManifest(config: ResolvedConfig, serviceId: string): boolean {
  const previous = config.manifest;
  const next: Manifest = { ...previous };

  next.$schema = previous.$schema ?? remoteSchemaUrl();
  next.version = previous.version ?? MANIFEST_VERSION;
  next.name = previous.name ?? config.name;
  next.serviceId = serviceId;
  if (config.environmentId !== undefined) {
    next.environmentId = previous.environmentId ?? config.environmentId;
  }
  next.output = previous.output ?? config.output;
  next.spa = previous.spa ?? config.spa;
  if (config.build !== undefined) next.build = previous.build ?? config.build;
  if (config.index !== undefined) next.index = previous.index ?? config.index;

  const unchanged = JSON.stringify(next) === JSON.stringify(previous);
  if (unchanged) return false;

  writeManifest(config.manifestPath, next);
  refreshLinkedLocalSchema(config.root, next);
  return true;
}
