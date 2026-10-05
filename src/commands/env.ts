/**
 * `naijacloud env` — environment variables on a service.
 *
 * Values are **masked by default**. The platform returns them in full and the
 * caller owns them, so this is not about trust: it is that `env ls` gets run on
 * shared screens and piped into build logs, and a printed credential cannot be
 * un-printed. `--reveal` is the explicit opt-in, and it is the flag that shows
 * up in a shell history when someone asks how a secret leaked.
 */

import process from "node:process";

import {
  deleteEnvVar,
  getService,
  listEnvVarKeysByProject,
  listEnvVarsByService,
  setEnvVar,
} from "../api/index.js";
import type { EnvVarMutationResult, EnvVarScope, ServiceEnvVar } from "../api/index.js";
import { scopeForEnvironment } from "../env-file.js";
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
): Promise<{ scope: EnvVarScope; environment: string | null }> {
  try {
    const service = await getService(serviceId);
    const name = service.environment?.name ?? null;
    return {
      scope: scopeForEnvironment({ name, isPreview: service.isPreview }),
      environment: name,
    };
  } catch {
    return { scope: "PROD", environment: null };
  }
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
  project: string | undefined;
  reveal: boolean;
  json: boolean;
}

export async function envList(options: EnvListOptions): Promise<void> {
  if (options.service && options.project) {
    throw new Error("Pass either --service or --project, not both.");
  }

  // A project-wide listing reads `envVarKeys`, which returns names only — no
  // value ever leaves the platform for it, so --reveal has nothing to reveal.
  if (options.project !== undefined) {
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
  );
  let scope: EnvVarScope;
  let scopeSource: string | null = null;
  if (options.scope !== undefined) {
    scope = parseScope(options.scope);
  } else {
    const derived = await scopeForService(serviceId);
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
  });
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                     */
/* -------------------------------------------------------------------------- */

export interface EnvRemoveOptions {
  service: string | undefined;
  yes: boolean;
  json: boolean;
}

export async function envRemove(key: string, options: EnvRemoveOptions): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Removing a variable",
    `env rm ${key} --service <name|id>`,
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
  if (result.needsRedeploy) {
    write(
      `Redeploy for this to take effect:\n` +
        `  ${programName()} redeploy ${context.serviceId}\n`,
    );
  }
}
