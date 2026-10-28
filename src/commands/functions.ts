/**
 * `naijacloud functions deploy | list | logs | delete` (TGL-1758).
 *
 * `deploy` prints the F7 output from the Functions design: one line per step
 * with ✓ or ✗ and words, so colour never carries the meaning; the URL on its
 * own line; then the next command to try. Steps and notes go to stderr, the
 * URL (the result) to stdout, so `URL=$(njc functions deploy hello …)` works.
 * Lines stay within 80 columns.
 */

import process from "node:process";

import {
  NaijaCloudError,
  apiBaseUrl,
  createCloudFunctionUpload,
  deleteCloudFunction,
  deployCloudFunction,
  getCloudFunction,
  getCurrentUser,
  getDeploymentLogs,
  listCloudFunctions,
  uploadToPresigned,
} from "../api/index.js";
import type {
  CloudFunction,
  CloudFunctionVersion,
  DeploymentStatus,
} from "../api/index.js";
import { formatWhen, printJson, printTable } from "../output.js";
import type { Column } from "../output.js";
import { programName } from "../program-name.js";
import { promptYesNo, requireTty, write } from "../terminal.js";
import {
  bundleFunction,
  formatSize,
  invalidNameMessage,
  isValidFunctionName,
  locateFunctionSource,
  sizeProblem,
} from "./function-source.js";
import type { FunctionBundle } from "./function-source.js";
import { looksLikeId, resolveEnvironment, resolveProjectId } from "./resolve.js";
import { waitForDeployment } from "./wait.js";

const WIDTH = 80;

/** How many build log lines a failed deploy shows. */
const FAILED_LOG_LINES = 20;

/**
 * A failure this module has already printed in full (the ✗ lines). The
 * entrypoint exits 1 for it without adding an "Error:" line of its own.
 */
export class ReportedError extends Error {
  readonly reported = true;
  constructor(message: string) {
    super(message);
    this.name = "ReportedError";
  }
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

/** Word-wraps `text` to {@link WIDTH}, the first line after `first`, the rest after `rest`. */
export function wrap(text: string, first: string, rest: string): string {
  const lines: string[] = [];
  let line = first;
  let empty = true;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (!empty && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = rest + word;
    } else {
      line += empty ? word : ` ${word}`;
    }
    empty = false;
  }
  lines.push(line);
  return lines.join("\n");
}

/** One step line: `  ✓ Bundled (3.1 KB)` or `  ✗ Build failed: …`, wrapped. */
function stepLine(ok: boolean, text: string): string {
  return `${wrap(text, `  ${ok ? "✓" : "✗"} `, "    ")}\n`;
}

/** Cuts a line to the width, marking the cut, so pasted build output cannot overflow. */
function fit(line: string, indent: string): string {
  const room = WIDTH - indent.length;
  const flat = line.replace(/\t/g, "  ").trimEnd();
  return indent + (flat.length > room ? `${flat.slice(0, room - 1)}…` : flat);
}

/** A redrawable progress line in a terminal; nothing at all when stderr is a pipe. */
function progress(): { show: (text: string) => void; clear: () => void } {
  const live = process.stderr.isTTY === true;
  let shown = false;
  return {
    show: (text) => {
      if (!live) return;
      write(`\r\x1b[2K  … ${text}`);
      shown = true;
    },
    clear: () => {
      if (live && shown) write("\r\x1b[2K");
      shown = false;
    },
  };
}

/** `naijacloud functions deploy hello --project shop`, quoted where a shell would need it. */
export function commandLine(args: readonly string[]): string {
  const quote = (arg: string): string =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
  return [programName(), "functions", ...args].map(quote).join(" ");
}

/**
 * The dashboard origin that goes with the configured API: `api.<domain>` →
 * `dashboard.<domain>`, so a staging API points at the staging dashboard.
 */
function dashboardOrigin(): string {
  try {
    const host = new URL(apiBaseUrl()).hostname;
    if (host.startsWith("api.")) return `https://dashboard.${host.slice(4)}`;
  } catch {
    // Fall through to production.
  }
  return "https://dashboard.naijacloud.com";
}

/** The page of the service the project's functions run in: logs, variables, metrics. */
export function runtimePageUrl(fn: CloudFunction, projectId: string): string {
  return `${dashboardOrigin()}/services/${encodeURIComponent(fn.runtimeServiceId)}?p=${encodeURIComponent(projectId)}`;
}

/* -------------------------------------------------------------------------- */
/* Lookups                                                                    */
/* -------------------------------------------------------------------------- */

/** `--env`: an id, `project/environment`, or a bare name inside `--project`. */
async function environmentId(project: string, env: string | undefined): Promise<string | undefined> {
  if (env === undefined) return undefined;
  const reference = looksLikeId(env) || env.includes("/") ? env : `${project}/${env}`;
  return (await resolveEnvironment(reference)).id;
}

/** Finds one function by name, refusing to guess between environments. */
async function findFunction(
  name: string,
  projectId: string,
  envId: string | undefined,
  project: string,
): Promise<CloudFunction> {
  const found = (await listCloudFunctions(projectId, { environmentId: envId, search: name })).filter(
    (fn) => fn.name === name,
  );
  if (found.length === 1) return found[0] as CloudFunction;
  if (found.length > 1) {
    throw new Error(
      `${name} exists in ${found.length} environments of ${project}. Name one with --env <environment>.`,
    );
  }
  throw new Error(
    `${project} has no function called ${name}` +
      `${envId ? " in that environment" : ""}. ` +
      `Run \`${programName()} functions list --project ${project}\` to see them.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Deploy                                                                     */
/* -------------------------------------------------------------------------- */

export interface DeployFunctionInput {
  name: string;
  /** Project name or id. */
  project: string;
  env?: string | undefined;
  file?: string | undefined;
  entry?: string | undefined;
  cwd: string;
  /** Recorded on the version, so the dashboard can show how it was deployed. */
  command: string;
}

export interface DeployFunctionOutcome {
  ok: boolean;
  name: string;
  functionId: string;
  url: string;
  region: string | null;
  version: number;
  deploymentId: string;
  status: DeploymentStatus;
  error: string | null;
  /** Version still serving after a failed deploy, or null when none was. */
  previousLiveVersion: number | null;
  /** Last build log lines of a failed deploy. */
  buildLog: string[];
  source: string;
  files: number;
  sizeBytes: number;
}

/** What `deployFunction` reports while it works; the CLI draws these as F7 steps. */
export interface DeployReporter {
  loggedIn?(email: string): void;
  bundled?(bundle: FunctionBundle): void;
  uploaded?(version: CloudFunctionVersion): void;
  status?(status: DeploymentStatus): void;
}

/** Throws before any network call when the name is not one the platform accepts. */
export function assertFunctionName(name: string): void {
  if (!isValidFunctionName(name)) throw new Error(invalidNameMessage(name));
}

/**
 * The whole deploy: package locally, reserve an upload, PUT it, deploy, and
 * wait for the runtime's build to settle. Shared by the CLI and the MCP tool.
 * Never throws for a build that failed — that is an outcome with `ok: false`.
 */
export async function deployFunction(
  input: DeployFunctionInput,
  reporter: DeployReporter = {},
): Promise<DeployFunctionOutcome> {
  assertFunctionName(input.name);

  // Everything local first, so a missing file or an oversized folder costs no request.
  const bundle = bundleFunction(locateFunctionSource(input.name, input.cwd, input.file), input.entry);
  const tooBig = sizeProblem(bundle.zip.length);
  if (tooBig) throw new Error(tooBig);

  // Decoration, but also the earliest check that the credentials work. An API
  // key without account access may not read /me; that must not block a deploy.
  try {
    reporter.loggedIn?.((await getCurrentUser()).email);
  } catch (error) {
    if (!(error instanceof NaijaCloudError && error.statusCode === 403)) throw error;
  }
  reporter.bundled?.(bundle);

  const projectId = await resolveProjectId(input.project);
  const envId = await environmentId(input.project, input.env);

  const slot = await createCloudFunctionUpload({
    projectId,
    environmentId: envId,
    name: input.name,
    sizeBytes: bundle.zip.length,
  });
  await uploadToPresigned(slot, bundle.zip);

  const result = await deployCloudFunction({
    projectId,
    environmentId: envId,
    name: input.name,
    uploadId: slot.uploadId,
    entrypoint: bundle.entrypoint,
    command: input.command,
  });
  reporter.uploaded?.(result.version);

  const settled = await waitForDeployment(result.deploy.id, result.deploy.status, (status) =>
    reporter.status?.(status),
  );
  const ok = settled.status !== "FAILED" && settled.status !== "CANCELLED";

  let fn = result.function;
  let error: string | null = null;
  let buildLog: string[] = [];
  if (!ok) {
    // Re-read for the version's plain-English reason; the deploy's own error
    // is the fallback when the function cannot be read.
    fn = await getCloudFunction(fn.id).catch(() => fn);
    const latest = fn.latestVersion?.id === result.version.id ? fn.latestVersion : null;
    error =
      latest?.errorMessage ??
      settled.error ??
      (settled.status === "CANCELLED" ? "the deploy was cancelled" : "the build did not finish");
    buildLog = (await getDeploymentLogs(result.deploy.id).catch(() => []))
      .slice(-FAILED_LOG_LINES)
      .map((entry) => entry.line);
  }

  const live = fn.liveVersion;
  return {
    ok,
    name: input.name,
    functionId: fn.id,
    url: fn.url,
    region: fn.region,
    version: result.version.number,
    deploymentId: result.deploy.id,
    status: settled.status,
    error,
    previousLiveVersion: !ok && live && live.id !== result.version.id ? live.number : null,
    buildLog,
    source: bundle.source.label,
    files: bundle.files,
    sizeBytes: bundle.zip.length,
  };
}

export interface FunctionsDeployOptions {
  project: string;
  env: string | undefined;
  file: string | undefined;
  entry: string | undefined;
  json: boolean;
  /** The arguments after `functions`, as typed, for the recorded command. */
  args: readonly string[];
}

/** `naijacloud functions deploy <name>`: the F7 output. */
export async function functionsDeploy(name: string, options: FunctionsDeployOptions): Promise<void> {
  const line = progress();
  const step = (ok: boolean, text: string): void => {
    line.clear();
    write(stepLine(ok, text));
  };
  function refuse(message: string): never {
    step(false, message);
    throw new ReportedError(message);
  }

  write("\n");
  if (!isValidFunctionName(name)) refuse(invalidNameMessage(name));

  let outcome: DeployFunctionOutcome;
  try {
    outcome = await deployFunction(
      {
        name,
        project: options.project,
        env: options.env,
        file: options.file,
        entry: options.entry,
        cwd: process.cwd(),
        command: commandLine(options.args),
      },
      {
        loggedIn: (email) => step(true, `Logged in as ${email}`),
        bundled: (bundle) => {
          const files = `${bundle.files} file${bundle.files === 1 ? "" : "s"}`;
          step(true, `Found ${bundle.source.label} (${files}, ${formatSize(bundle.sourceBytes)})`);
          step(true, `Bundled (${formatSize(bundle.zip.length)})`);
          line.show("Uploading");
        },
        uploaded: (version) => step(true, `Uploaded version ${version.number}`),
        status: (status) => line.show(status.charAt(0) + status.slice(1).toLowerCase()),
      },
    );
  } catch (error) {
    // Every failure reads as a step, in the same ✗ form as the rest.
    refuse(error instanceof Error ? error.message : String(error));
  }
  line.clear();

  const program = programName();
  const next = `${program} functions logs ${name} --project ${options.project}`;

  if (outcome.ok) {
    step(true, outcome.region ? `Live in ${outcome.region}` : "Live");
    if (options.json) {
      printJson(outcome);
    } else {
      write("\n");
      process.stdout.write(process.stdout.isTTY ? `  ${outcome.url}\n` : `${outcome.url}\n`);
    }
    write(`\n  Next: ${next}\n`);
    return;
  }

  const verb = outcome.status === "CANCELLED" ? "Deploy stopped" : "Build failed";
  step(false, `${verb}: ${outcome.error ?? "no reason was given"}`);
  if (outcome.buildLog.length > 0) {
    write(`\n  Build log, last ${outcome.buildLog.length} lines:\n`);
    for (const entry of outcome.buildLog) write(`${fit(entry, "    ")}\n`);
  }
  write("\n");
  write(
    `${wrap(
      outcome.previousLiveVersion !== null
        ? `This deploy failed, so the previous version (v${outcome.previousLiveVersion}) is still live.`
        : `This deploy failed, and no earlier version of ${name} was live.`,
      "  ",
      "  ",
    )}\n`,
  );
  write(`  Full build log: ${program} deployments logs ${outcome.deploymentId}\n`);
  if (options.json) printJson(outcome);
  throw new ReportedError(`Deploy of ${name} failed.`);
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

function count(value: number | null): string {
  return value === null || value === undefined ? "-" : String(value);
}

export async function functionsList(options: {
  project: string;
  env: string | undefined;
  json: boolean;
}): Promise<void> {
  const projectId = await resolveProjectId(options.project);
  const functions = await listCloudFunctions(projectId, {
    environmentId: await environmentId(options.project, options.env),
  });

  if (options.json) {
    printJson({ count: functions.length, functions });
    return;
  }

  const columns: Column<CloudFunction>[] = [
    { header: "NAME", value: (fn) => fn.name },
    { header: "STATUS", value: (fn) => fn.status },
    { header: "CALLS 24H", value: (fn) => count(fn.calls24h), align: "right" },
    { header: "ERRORS 24H", value: (fn) => count(fn.errors24h), align: "right" },
    {
      header: "LAST DEPLOYED",
      value: (fn) => formatWhen((fn.latestVersion ?? fn.liveVersion)?.createdAt ?? fn.updatedAt),
    },
    { header: "URL", value: (fn) => fn.url },
  ];
  printTable(
    functions,
    columns,
    `No functions in ${options.project} yet. Deploy one:\n` +
      `  ${programName()} functions deploy hello --project ${options.project}`,
  );
}

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What can be read without the socket.io stream: where the live logs are, and
 * the newest deploy's build log. Runtime lines exist only on the dashboard's
 * live stream today; there is no request-reply API for them to read here.
 */
export async function functionsLogs(
  name: string,
  options: { project: string; env: string | undefined; limit: number | undefined; json: boolean },
): Promise<void> {
  if (!isValidFunctionName(name)) throw new Error(invalidNameMessage(name));
  const projectId = await resolveProjectId(options.project);
  const fn = await findFunction(
    name,
    projectId,
    await environmentId(options.project, options.env),
    options.project,
  );
  const page = runtimePageUrl(fn, projectId);
  const version = fn.latestVersion;
  const deployId = version?.deployId ?? null;
  const logs = deployId ? await getDeploymentLogs(deployId) : [];
  const shown = options.limit ? logs.slice(-options.limit) : logs;

  if (options.json) {
    printJson({
      name,
      functionId: fn.id,
      status: fn.status,
      logsUrl: page,
      linePrefix: `[fn:${name}`,
      build: version
        ? { version: version.number, deploymentId: deployId, total: logs.length, lines: shown }
        : null,
    });
    return;
  }

  write(
    `${wrap(
      `Live logs are in the dashboard. There, each line ${name} prints starts with [fn:${name}.`,
      "",
      "",
    )}\n  ${page}\n\n`,
  );
  if (!version || !deployId) {
    write(`${name} has no build log yet.\n`);
    return;
  }
  write(`Build log for version ${version.number} (${version.status.toLowerCase()}):\n`);
  if (shown.length === 0) {
    write("  No build log lines yet.\n");
    return;
  }
  for (const entry of shown) {
    const marker = entry.level === "ERROR" ? "!" : entry.level === "WARN" ? "*" : " ";
    process.stdout.write(`${marker} ${entry.line}\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                     */
/* -------------------------------------------------------------------------- */

export async function functionsDelete(
  name: string,
  options: { project: string; env: string | undefined; yes: boolean; json: boolean },
): Promise<void> {
  if (!isValidFunctionName(name)) throw new Error(invalidNameMessage(name));
  const program = programName();
  if (!options.yes) {
    requireTty(`Deleting ${name}`, [
      `${program} functions delete ${name} --project ${options.project} --yes`,
    ]);
  }

  const projectId = await resolveProjectId(options.project);
  const fn = await findFunction(
    name,
    projectId,
    await environmentId(options.project, options.env),
    options.project,
  );

  if (!options.yes) {
    const confirmed = await promptYesNo(
      `Delete ${name}? Its URL stops working at once, and its logs are removed with it.`,
      false,
    );
    if (!confirmed) {
      write(`${name} was not deleted.\n`);
      return;
    }
  }

  await deleteCloudFunction(fn.id);
  if (options.json) {
    printJson({ deleted: true, id: fn.id, name });
    return;
  }
  process.stdout.write(`Deleted ${name}. ${fn.url} no longer answers.\n`);
}
