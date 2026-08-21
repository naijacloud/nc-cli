/**
 * `naijacloud env import` — a `.env` file onto a service.
 *
 * Also the shared implementation of "hand me your configuration" for the flows
 * that create a service, so the file is read, previewed and classified the same
 * way whether it is being imported into a service that already exists or handed
 * to `createService` before one does.
 *
 * Two rules shape the behaviour, both about not surprising anyone:
 *
 *   - **A `.env` is never picked up implicitly without a terminal.** In CI, a
 *     stray `.env` in the checkout would otherwise be uploaded by a command
 *     nobody thought was about secrets. `--env-file` is how a script asks.
 *   - **Nothing is written before it has been shown.** Keys, scope and which
 *     values were classified as secret are printed first, values masked, and the
 *     import is confirmed.
 */

import process from "node:process";

import { setEnvVars } from "../api/index.js";
import type { EnvVarInput, EnvVarScope } from "../api/index.js";
import {
  findEnvFiles,
  maskValue,
  readEnvFile,
  scopeForEnvironment,
  toEnvVarInputs,
} from "../env-file.js";
import type { ParsedEnvFile } from "../env-file.js";
import { printJson, renderTable } from "../output.js";
import { programName } from "../program-name.js";
import { isInteractive, promptLine, promptYesNo, write } from "../terminal.js";
import { parseScope } from "./env.js";
import { requireService, resolveEnvironment } from "./resolve.js";

/* -------------------------------------------------------------------------- */
/* Preview                                                                    */
/* -------------------------------------------------------------------------- */

/** Where the file's contents came from and what they mean, for the reader. */
function preview(path: string, parsed: ParsedEnvFile, scope: EnvVarScope): void {
  const secrets = parsed.entries.filter((entry) => entry.secret).length;

  write(
    `\n${path} — ${parsed.entries.length} variable${parsed.entries.length === 1 ? "" : "s"}` +
      `${secrets > 0 ? `, ${secrets} classified as secret` : ""}\n\n`,
  );

  // stderr, like every other prompt: this is the question, not the answer, and
  // `env import --json` must not have it spliced into the document on stdout.
  write(
    parsed.entries.length === 0
      ? "  The file defines no variables.\n"
      : renderTable(
          parsed.entries,
          [
            { header: "KEY", value: (entry) => entry.key },
            { header: "SECRET", value: (entry) => (entry.secret ? "yes" : "no") },
            // Masked even here. This is the one screen guaranteed to be looking
            // at credentials, and it is often the screen someone is sharing.
            { header: "VALUE", value: (entry) => maskValue(entry.value) },
          ],
          "  ",
        ),
  );

  if (parsed.skipped.length > 0) {
    write(`\nSkipped ${parsed.skipped.length} line(s):\n`);
    for (const skip of parsed.skipped) {
      write(`  line ${skip.line}${skip.key ? ` (${skip.key})` : ""}: ${skip.reason}\n`);
    }
  }

  write(`\n  Scope  ${scope}\n`);
}

/* -------------------------------------------------------------------------- */
/* Collecting variables for a service that does not exist yet                 */
/* -------------------------------------------------------------------------- */

export interface CollectOptions {
  /** Explicit path from `--env-file`. Bypasses discovery and must exist. */
  file: string | undefined;
  /** Directory searched for a `.env` when no path was given. */
  cwd: string;
  /** Ask about a file that was found, and offer to name one that was not. */
  interactive: boolean;
  /** Whether the target environment is a preview one; decides the scope. */
  isPreview: boolean;
  /** Overrides the scope derived from the environment. */
  scope: string | undefined;
  /** Mark every imported variable secret, whatever the name suggests. */
  forceSecret: boolean;
  /** Skip the question and import nothing. */
  skip: boolean;
}

export interface CollectedEnv {
  vars: EnvVarInput[];
  /** The file they came from, or null when nothing was imported. */
  source: string | null;
}

/**
 * Resolves the variables a new service should be created with.
 *
 * Returns an empty list rather than throwing when there is nothing to import —
 * a service with no configuration is an ordinary thing to create, and the only
 * hard failure here is a `--env-file` that was named and cannot be read.
 */
export async function collectEnvVars(options: CollectOptions): Promise<CollectedEnv> {
  const scope = options.scope !== undefined
    ? parseScope(options.scope)
    : scopeForEnvironment(options.isPreview);

  if (options.skip) return { vars: [], source: null };

  let path = options.file;

  if (path === undefined) {
    const found = findEnvFiles(options.cwd);

    if (!options.interactive) {
      // Deliberate: see the note at the top. A file found by chance is reported
      // so the omission is visible, but never uploaded on its own.
      if (found.length > 0) {
        write(
          `Note: ${found[0]!} exists but was not imported. Pass --env-file to import it.\n`,
        );
      }
      return { vars: [], source: null };
    }

    if (found.length > 0) {
      const candidate = found[0]!;
      const parsed = readEnvFile(candidate);
      preview(candidate, parsed, scope);

      if (parsed.entries.length === 0) {
        return { vars: [], source: null };
      }
      const confirmed = await promptYesNo(
        `  Import these ${parsed.entries.length} into the new service?`,
        true,
      );
      if (!confirmed) return { vars: [], source: null };

      return {
        vars: toEnvVarInputs(parsed.entries, scope, { forceSecret: options.forceSecret }),
        source: candidate,
      };
    }

    const answer = (
      await promptLine("  Env file         (path to a .env, blank for none): ")
    ).trim();
    if (answer === "") return { vars: [], source: null };
    path = answer;
  }

  const parsed = readEnvFile(path);
  if (parsed.entries.length === 0) {
    write(`${path} defines no variables; nothing to import.\n`);
    return { vars: [], source: null };
  }

  if (options.interactive) {
    preview(path, parsed, scope);
    const confirmed = await promptYesNo(`  Import these ${parsed.entries.length}?`, true);
    if (!confirmed) return { vars: [], source: null };
  }

  return {
    vars: toEnvVarInputs(parsed.entries, scope, { forceSecret: options.forceSecret }),
    source: path,
  };
}

/* -------------------------------------------------------------------------- */
/* The command                                                                */
/* -------------------------------------------------------------------------- */

export interface EnvImportOptions {
  service: string | undefined;
  /** Environment the service lives in, when the scope cannot be derived. */
  env: string | undefined;
  scope: string | undefined;
  secret: boolean;
  yes: boolean;
  json: boolean;
}

/**
 * Imports a `.env` onto an existing service.
 *
 * Upserts: keys in the file are created or updated, keys already on the service
 * and absent from the file are left alone. That makes a re-import safe, and it
 * makes this the wrong tool for removing a variable — `env rm` is.
 */
export async function envImport(
  file: string | undefined,
  options: EnvImportOptions,
): Promise<void> {
  const serviceId = await requireService(
    options.service,
    process.cwd(),
    "Importing variables",
    "env import .env --service <name|id>",
  );

  const path = file ?? findEnvFiles(process.cwd())[0];
  if (path === undefined) {
    throw new Error(
      "No .env file here. Name one:\n" +
        `  ${programName()} env import path/to/.env --service <name|id>`,
    );
  }

  // Only consulted to derive the scope, and only when one was not given — so a
  // scripted import with --scope costs no extra request.
  let isPreview = false;
  if (options.scope === undefined && options.env !== undefined) {
    isPreview = (await resolveEnvironment(options.env)).isPreview;
  }
  const scope = options.scope !== undefined
    ? parseScope(options.scope)
    : scopeForEnvironment(isPreview);

  const parsed = readEnvFile(path);
  if (parsed.entries.length === 0) {
    throw new Error(
      `${path} defines no variables.` +
        (parsed.skipped.length > 0
          ? ` ${parsed.skipped.length} line(s) could not be read.`
          : ""),
    );
  }

  if (!options.yes && isInteractive()) {
    preview(path, parsed, scope);
    const confirmed = await promptYesNo(
      `  Import these ${parsed.entries.length} into ${serviceId}?`,
      true,
    );
    if (!confirmed) {
      write("Nothing imported.\n");
      return;
    }
  }

  const vars = toEnvVarInputs(parsed.entries, scope, { forceSecret: options.secret });
  const result = await setEnvVars(serviceId, vars);

  if (options.json) {
    printJson({
      ok: true,
      serviceId,
      source: path,
      scope,
      imported: vars.length,
      // Keys only. The mutation echoes every variable on the service in full,
      // and returning that from a write would leak the ones not being imported.
      keys: vars.map((variable) => variable.key),
      skipped: parsed.skipped,
      needsRedeploy: result.needsRedeploy,
      warnings: result.warnings,
    });
    return;
  }

  process.stdout.write(
    `Imported ${vars.length} variable${vars.length === 1 ? "" : "s"} from ${path} (${scope})\n`,
  );
  for (const warning of result.warnings) write(`Warning: ${warning}\n`);
  if (result.needsRedeploy) {
    write(
      "Redeploy for these to take effect:\n" +
        `  ${programName()} redeploy ${serviceId}\n`,
    );
  }
}
