/**
 * `naijacloud env` — environment variables on a service.
 *
 * Values are **masked by default**. The platform returns them in full and the
 * caller owns them, so this is not about trust: it is that `env ls` gets run on
 * shared screens and piped into build logs, and a printed credential cannot be
 * un-printed. `--reveal` is the explicit opt-in, and it is the flag that shows
 * up in a shell history when someone asks how a secret leaked.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve as resolvePath } from "node:path";
import process from "node:process";

import {
  deleteEnvVar,
  getService,
  listEnvVarKeysByProject,
  listEnvVarsByService,
  setEnvVar,
} from "../api/index.js";
import type { EnvVarMutationResult, EnvVarScope, ServiceEnvVar } from "../api/index.js";
import { formatEnvFile, scopeForEnvironment } from "../env-file.js";
import { printJson, printTable } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptLine, promptYesNo, write } from "../terminal.js";
import { requireService, resolveProjectId } from "./resolve.js";

/**
 * Scope names accepted on the command line.
 *
 * Both the platform's own enum and the friendlier words the dashboard and MCP
 * server use, because someone who has read either should not have to translate.
 * `preview` is UAT — NaijaCloud has no PREVIEW scope, and UAT is what preview
 * environments read.
 */
const SCOPES: Record<string, EnvVarScope> = {
  all: "ALL",
  prod: "PROD",
  production: "PROD",
  uat: "UAT",
  preview: "UAT",
  dev: "DEV",
  development: "DEV",
};

export function parseScope(raw: string): EnvVarScope {
  const scope = SCOPES[raw.trim().toLowerCase()];
  if (!scope) {
    throw new Error(
      `Unknown scope '${raw}'. Use one of: all, prod, uat (preview), dev.`,
    );
  }
  return scope;
}

/**
 * The scope a service's own environment reads, for a write that named none.
 *
 * Read from the service rather than assumed: new projects start in `dev`, and a
 * `dev` environment never receives PROD-scoped variables, so the old PROD
 * default wrote variables that looked set and never reached the app.
 *
 * `environment` is null when the service could not be read (a key without
 * access to it, say); the scope then falls back to PROD, as before.
 */
export async function scopeForService(
  serviceId: string,
): Promise<{ scope: EnvVarScope; environment: string | null; uploadedStatic: boolean }> {
  try {
    const service = await getService(serviceId);
    const name = service.environment?.name ?? null;
    return {
      scope: scopeForEnvironment({ name, isPreview: service.isPreview }),
      environment: name,
      uploadedStatic: isUploadedStatic(service),
    };
  } catch {
    return { scope: "PROD", environment: null, uploadedStatic: false };
  }
}

/**
 * A static site uploaded by `deploy`: plain files with no build on the
 * platform, so environment variables never reach it. A static site built from
 * a repository does read them, at build time.
 */
function isUploadedStatic(service: { isStatic: boolean; repoFullName: string | null; sourceType: string | null }): boolean {
  return service.isStatic && !service.repoFullName && !service.sourceType;
}

/** `********` plus the true length, which confirms a write landed without showing it. */
function mask(variable: ServiceEnvVar): string {
  return `******** (${variable.value.length})`;
}

/* -------------------------------------------------------------------------- */
/* List                                                                       */
/* -------------------------------------------------------------------------- */

export interface EnvListOptions {
  service: string | undefined;
  /** Alone: every service's keys in the project. With --service: where to find it. */
  project: string | undefined;
  /** With --service: the environment to find it in. */
  env?: string | undefined;
  reveal: boolean;
  json: boolean;
}

export async function envList(options: EnvListOptions): Promise<void> {
  // A project-wide listing reads `envVarKeys`, which returns names only — no
  // value ever leaves the platform for it, so --reveal has nothing to reveal.
  // --project alone lists the whole project; with --service it only says where to look.
  if (options.project !== undefined && !options.service) {
    const services = await listEnvVarKeysByProject(await resolveProjectId(options.project));

    if (options.json) {
      printJson({ services });
      return;
    }

    const rows = services.flatMap((service) =>
      service.keys.map((key) => ({ ...service, key })),
    );
    printTable(
      rows,
      [
        { header: "SERVICE", value: (row) => row.serviceName },
        { header: "ENV", value: (row) => row.environmentName },
        { header: "KEY", value: (row) => row.key },
      ],
      "No environment variables set anywhere in this project.",
    );
    if (rows.length > 0) {
      write(
        `\nKeys only. For values, list one service: ` +
          `\`${programName()} env ls --service <name>\`\n`,
      );
    }
    return;
  }

  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Listing variables",
    "env ls --service <name|id>",
    { project: options.project, env: options.env },
  );
  const variables = await listEnvVarsByService(serviceId);

  if (options.json) {
    printJson({
      serviceId,
      count: variables.length,
      revealed: options.reveal,
      envVars: options.reveal
        ? variables
        : variables.map((variable) => ({
            ...variable,
            value: null,
            valueLength: variable.value.length,
          })),
    });
    return;
  }

  printTable(
    variables,
    [
      { header: "KEY", value: (variable) => variable.key },
      { header: "SCOPE", value: (variable) => variable.scope },
      { header: "SECRET", value: (variable) => (variable.secret ? "yes" : "no") },
      { header: "VALUE", value: (variable) => (options.reveal ? variable.value : mask(variable)) },
    ],
    "No environment variables on this service.",
  );

  if (variables.length > 0 && !options.reveal) {
    write(`\nValues hidden. Add --reveal to print them.\n`);
  }
}

/* -------------------------------------------------------------------------- */
/* Set                                                                        */
/* -------------------------------------------------------------------------- */

export interface EnvSetOptions {
  service: string | undefined;
  /** Where to find --service: its project, and environment in it. */
  project?: string | undefined;
  env?: string | undefined;
  scope: string | undefined;
  secret: boolean;
  json: boolean;
}

/**
 * Reads a value that was not given on the command line.
 *
 * Worth the extra path: an argument lands in shell history and in the process
 * table, where a credential should never be. A pipe (`… | njc env set KEY`)
 * covers CI, a hidden prompt covers a terminal.
 */
async function readValue(key: string): Promise<string> {
  if (isInteractive()) {
    return await promptLine(`Value for ${key} (hidden): `, { hidden: true });
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const piped = Buffer.concat(chunks).toString("utf8");

  if (piped === "") {
    throw new Error(
      `No value for ${key}. Pass it as an argument, or pipe it in:\n` +
        `  echo -n "<value>" | ${programName()} env set ${key}`,
    );
  }
  // One trailing newline is the shell's, not the value's; anything else is
  // deliberate and preserved.
  return piped.replace(/\n$/, "");
}

export async function envSet(
  key: string,
  rawValue: string | undefined,
  options: EnvSetOptions,
): Promise<void> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `'${key}' is not a valid variable name — start with a letter or underscore, ` +
        "then letters, digits and underscores only.",
    );
  }

  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Setting a variable",
    `env set ${key} VALUE --service <name|id>`,
    { project: options.project, env: options.env },
  );
  let scope: EnvVarScope;
  let scopeSource: string | null = null;
  // Read the service only when the scope has to be derived from it; the same
  // read says whether it is an uploaded static site (see report()).
  let uploadedStatic = false;
  if (options.scope !== undefined) {
    scope = parseScope(options.scope);
  } else {
    const derived = await scopeForService(serviceId);
    uploadedStatic = derived.uploadedStatic;
    scope = derived.scope;
    if (derived.environment !== null) scopeSource = `from environment ${derived.environment}`;
  }
  const value = rawValue ?? (await readValue(key));

  const result = await setEnvVar(serviceId, key, value, scope, options.secret || undefined);
  report(result, {
    serviceId,
    key,
    scope,
    // Says where the scope came from, so `(DEV)` is not a surprise to someone
    // who expected the old PROD default.
    scopeSource,
    json: options.json,
    verb: "set",
    uploadedStatic,
  });
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                     */
/* -------------------------------------------------------------------------- */

export interface EnvRemoveOptions {
  service: string | undefined;
  project?: string | undefined;
  env?: string | undefined;
  yes: boolean;
  json: boolean;
}

export async function envRemove(key: string, options: EnvRemoveOptions): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Removing a variable",
    `env rm ${key} --service <name|id>`,
    { project: options.project, env: options.env },
  );

  // The API answers a delete of a key that does not exist with success, so
  // without this check a typo is reported as "removed".
  const existing = await listEnvVarsByService(serviceId);
  if (!existing.some((variable) => variable.key === key)) {
    throw new Error(
      `No variable called ${key} on service ${serviceId}. ` +
        `Run \`${programName()} env ls --service ${serviceId}\` to see its variables.`,
    );
  }

  if (!options.yes && isInteractive()) {
    const confirmed = await promptYesNo(`Remove ${key} from service ${serviceId}?`, false);
    if (!confirmed) {
      write("Left in place.\n");
      return;
    }
  }

  const result = await deleteEnvVar(serviceId, key);
  report(result, {
    serviceId,
    key,
    scope: null,
    scopeSource: null,
    json: options.json,
    verb: "removed",
  });
}

/* -------------------------------------------------------------------------- */
/* Pull                                                                       */
/* -------------------------------------------------------------------------- */

/** Where `env pull` writes when no file is named: what Next.js, Vite and most dotenv setups read and ignore. */
export const DEFAULT_PULL_FILE = ".env.local";

export interface EnvPullOptions {
  service: string | undefined;
  project?: string | undefined;
  env?: string | undefined;
  yes: boolean;
  json: boolean;
}

/**
 * Whether the platform injects a variable of `scope` into an environment called
 * `environment`: ALL always; PROD, UAT or DEV only into the environment of that
 * name; and into an environment with any other name, every scope. The control
 * plane's own rule (scopeAppliesToEnv), so the file matches what the app sees.
 * An environment that could not be read (null) keeps every variable.
 */
export function scopeApplies(scope: EnvVarScope, environment: string | null): boolean {
  if (scope === "ALL" || environment === null) return true;
  const tier = environment.trim().toUpperCase();
  if (tier !== "PROD" && tier !== "UAT" && tier !== "DEV") return true;
  return tier === scope;
}

/**
 * Whether git would commit `file`: true when it is inside a work tree and no
 * ignore rule covers it, false when one does, and null when that cannot be
 * told (not a repository, or no git on this machine).
 */
export function committable(file: string): boolean | null {
  const result = spawnSync("git", ["check-ignore", "-q", "--", basename(file)], {
    cwd: dirname(file),
    stdio: "ignore",
    windowsHide: true,
  });
  if (result.error) return null;
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  return null;
}

/**
 * `env pull [file]` — writes a service's variables to a local dotenv file
 * (`.env.local` unless named), for running the app here with the same
 * configuration.
 *
 * The file holds credentials in plain text, so nothing is written until the
 * keys (never the values) have been shown and the user has said yes; without a
 * terminal, --yes is the only way to say it. The file is created 0600, and a
 * file git would commit is called out before the question rather than after.
 */
export async function envPull(file: string | undefined, options: EnvPullOptions): Promise<void> {
  const target = resolvePath(process.cwd(), file ?? DEFAULT_PULL_FILE);
  if (existsSync(target) && !statSync(target).isFile()) {
    throw new Error(`${target} exists and is not a file.`);
  }

  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Pulling variables",
    "env pull [file] --service <name|id>",
    { project: options.project, env: options.env },
  );

  let environment: string | null = null;
  try {
    environment = (await getService(serviceId)).environment?.name ?? null;
  } catch {
    // A key that cannot read the service still reads its variables; keep them all.
  }
  const all = await listEnvVarsByService(serviceId);
  const variables = all.filter((variable) => scopeApplies(variable.scope, environment));
  const leftOut = all.length - variables.length;

  if (variables.length === 0) {
    throw new Error(
      all.length === 0
        ? `Service ${serviceId} has no environment variables; nothing to write.`
        : `None of service ${serviceId}'s ${all.length} variable(s) reach its environment ${environment}; nothing to write.`,
    );
  }

  // A read-only role is answered with every value blanked. Writing that file
  // would look like a pull and leave the app with empty credentials.
  if (variables.every((variable) => variable.value === "")) {
    throw new Error(
      `Every value came back empty: your role on service ${serviceId} can list its variables but not read them. ` +
        "Pull with a role that can, or ask someone who has one.",
    );
  }

  const exists = existsSync(target);
  const tracked = committable(target);
  const display = file ?? DEFAULT_PULL_FILE;

  write(
    `${variables.length} variable(s) from service ${serviceId}` +
      `${environment ? ` (environment ${environment})` : ""} → ${target}\n`,
  );
  for (const variable of variables) {
    write(`  ${variable.key}${variable.secret ? "  (secret)" : ""}${variable.value === "" ? "  (empty)" : ""}\n`);
  }
  if (leftOut > 0) {
    write(`Left out ${leftOut} variable(s) scoped to another environment.\n`);
  }
  write("Values are written in plain text: anyone who can read the file can read the secrets.\n");
  if (exists) write(`Warning: ${display} already exists and will be overwritten.\n`);
  if (tracked === true) {
    write(
      `Warning: ${display} is not in .gitignore, so git would commit it. Add it first:\n` +
        `  echo '${basename(target)}' >> .gitignore\n`,
    );
  }

  if (!options.yes) {
    if (!isInteractive()) {
      throw new Error(
        `env pull writes secrets to ${display} and needs a confirmation. Without a terminal, pass --yes:\n` +
          `  ${programName()} env pull${file ? ` ${file}` : ""} --service ${serviceId} --yes`,
      );
    }
    const confirmed = await promptYesNo(
      exists ? `Overwrite ${display} with these ${variables.length} variable(s)?` : `Write ${display}?`,
      false,
    );
    if (!confirmed) {
      write("Nothing written.\n");
      return;
    }
  }

  const content = formatEnvFile(variables, [
    `Pulled from NaijaCloud service ${serviceId} by \`${programName()} env pull\` on ${new Date().toISOString()}.`,
    "Holds secrets: do not commit it.",
  ]);
  // Truncate to empty and tighten the mode before any secret goes in, so an
  // existing file that was 0644 is never briefly readable with them in it.
  writeFileSync(target, "", { mode: 0o600 });
  chmodSync(target, 0o600);
  writeFileSync(target, content);

  if (options.json) {
    printJson({
      ok: true,
      serviceId,
      file: target,
      count: variables.length,
      keys: variables.map((variable) => variable.key),
      overwritten: exists,
      gitignored: tracked === null ? null : !tracked,
    });
    return;
  }
  process.stdout.write(`Wrote ${variables.length} variable(s) to ${display}\n`);
}

/* -------------------------------------------------------------------------- */
/* Shared reporting                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Both mutations return the same shape, and the part that matters is
 * `needsRedeploy`: a running process keeps the environment it started with, so
 * a write that looks successful still has not taken effect.
 */
function report(
  result: EnvVarMutationResult,
  context: {
    serviceId: string;
    key: string;
    scope: EnvVarScope | null;
    /** Why this scope, when it was derived rather than passed. */
    scopeSource: string | null;
    json: boolean;
    verb: string;
    /** A `deploy`-uploaded static site, which never reads variables. */
    uploadedStatic?: boolean;
  },
): void {
  if (context.json) {
    printJson({
      ok: true,
      serviceId: context.serviceId,
      key: context.key,
      scope: context.scope,
      needsRedeploy: result.needsRedeploy,
      warnings: result.warnings,
      // Keys only. The response echoes every variable on the service in full,
      // and returning that from a write would leak the rest of them.
      keys: result.envVars.map((variable) => variable.key),
    });
    return;
  }

  const scopeNote = context.scope
    ? ` (${context.scope}${context.scopeSource ? `, ${context.scopeSource}` : ""})`
    : "";
  process.stdout.write(`${context.key} ${context.verb}${scopeNote}\n`);
  for (const warning of result.warnings) write(`Warning: ${warning}\n`);
  if (context.uploadedStatic) {
    write(
      "Note: this is a static site uploaded with `deploy`. Its files are served as they are, " +
        "so it never reads environment variables; put the value in the files at build time instead.\n",
    );
  } else if (result.needsRedeploy) {
    write(
      `Redeploy for this to take effect:\n` +
        `  ${programName()} redeploy ${context.serviceId}\n`,
    );
  }
}
