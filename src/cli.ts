#!/usr/bin/env node
/**
 * `naijacloud` entrypoint — argument parsing and dispatch.
 *
 * Installed under two names: `naijacloud` and the shorter `njc`. Both are the
 * same executable, so every command below works either way.
 *
 * Under `naijacloud mcp` stdout is owned by the MCP protocol, so this file
 * writes help, errors and diagnostics to stderr and keeps stdout for command
 * output only. The resource commands hold to the same split for a different
 * reason: their result goes to stdout so `--json` stays pipeable, and progress
 * and prompts go to stderr so they do not corrupt it.
 *
 * Command modules are imported lazily. `login` and `whoami` should not pay to
 * load zod, the archive machinery or the MCP SDK.
 */

import process from "node:process";

import { CLIENT_VERSION, DEFAULT_API_BASE_URL } from "./api/index.js";
import { TOKEN_ENV_VAR } from "./auth/credentials.js";
import { login, logout, whoami } from "./commands/auth.js";
import { ALIAS, PROGRAM, programName } from "./program-name.js";

/** Column where every description starts, matching the option lists below. */
const DESCRIPTION_COLUMN = 28;

/**
 * The command list, grouped.
 *
 * Grouped rather than flat because the surface has outgrown a single list: the
 * three sections are "get in", "ship something" and "inspect or change what is
 * already there", which is the order someone meets them in.
 */
const GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, string]>]> = [
  [
    "Auth",
    [
      ["login [options]", "Authenticate and store credentials (mode 0600)"],
      ["logout", "Delete stored credentials"],
      ["whoami", "Show the authenticated account"],
    ],
  ],
  [
    "Ship",
    [
      ["launch [dir]", "Guided: project → environment → service"],
      ["deploy [dir]", "Build, upload and release a static site"],
      ["redeploy [service]", "Rebuild a repo-connected service from its branch"],
      ["init [dir]", "Write a naijacloud.json, without deploying"],
      ["schema [--write]", "Print the naijacloud.json JSON Schema"],
    ],
  ],
  [
    "Explore",
    [
      ["project [name|id]", "Interactive: environments, services, actions"],
    ],
  ],
  [
    "Resources",
    [
      ["projects ls|show|create", "Projects, environments and their services"],
      ["environments ls|create|rm", "Environments inside a project"],
      ["services ls|show|create", "Services this account can reach"],
      ["deployments ls|show|logs", "Deployment history and build output"],
      ["cancel <deployment>", "Stop an in-flight deployment"],
      ["env ls|set|rm|import", "Environment variables on a service"],
      ["domains ls|add|verify|rm", "Custom domains on a service"],
      ["db query|shell|tables", "SQL console; also describe, dump, export"],
    ],
  ],
  [
    "Other",
    [
      ["mcp", "Run the MCP server over stdio"],
      ["--help", "Show this message"],
      ["--version", "Show the version"],
    ],
  ],
];

/**
 * Padded rather than hard-coded, so the descriptions stay in one column for
 * both `naijacloud` and the seven-characters-shorter `njc`.
 */
function usage(program: string): string {
  const lines = GROUPS.map(
    ([title, commands]) =>
      `${title}\n` +
      commands
        .map(([command, description]) => `  ${command.padEnd(DESCRIPTION_COLUMN)} ${description}`)
        .join("\n"),
  ).join("\n\n");

  return `${program} — CLI and MCP server for NaijaCloud hosting

Usage
  ${program} <command> [options]

${lines}

Resource options
  --service <name|id>          Target service; defaults to naijacloud.json's
  --project <name|id>          Target project, where a command accepts one
  --json                       Machine-readable result on stdout
  --yes                        Skip the confirmation prompt
  --limit <n>                  Cap how many rows are returned

  Services and projects are named or referenced by id. Where one name matches
  two services, qualify it as project/name.

Launch options
  --dotenv <path>              Seed the new service from this .env
  --no-env-file                Do not look for or ask about a .env
  --no-wait                    Return once the first build is queued

  Walks team → project → environment → service, creating each level that does
  not exist yet. A web service or cron job is built from a connected GitHub
  repository; a static site is built here and uploaded. For a service that
  needs configuration it offers the .env it finds, shows what is in it with the
  values masked, and passes it to \`createService\` — so the first build already
  has it, instead of failing and being fixed afterwards.

Projects create options
  --team <name|id>             Team to own it; required if you have several
  --description <text>         Freeform description
  --display-name <text>        Human-facing name, when it differs from --name

Environments options
  --project <name|id>          Project to list in or create under (required)
  --yes                        Skip the confirmation on rm

  \`environments rm\` deletes every service in the environment with it, so the
  prompt names them. Spelled in full because \`env\` is variables, not this.

Services create options
  --env <project/environment>  Where it lives (required)
  --repo <owner/repo>          GitHub repository to build from (required)
  --branch <name>              Branch to build (default: the repo's own)
  --type <web|cron>            Kind of service (default web)
  --schedule <cron>            Cron expression; required for --type cron
  --build <command>            Build command
  --start <command>            Start command
  --port <n>                   Port the service listens on
  --root-dir <path>            Subdirectory to build, for a monorepo
  --runtime-version <version>  Runtime version, when not the default
  --health-check <path>        HTTP path polled for health
  --region <key>               Region, when not the team's default
  --tier <starter|standard|pro>  Resource size
  --dotenv <path>              Seed the service with this .env
  --no-env-file                Do not look for a .env
  --no-wait                    Return once the first build is queued

  A repository is the only source: the platform builds from a repo it can
  reach, and there is no upload-and-build path for a web service. Local code is
  either a static site (\`deploy\`) or it is in a repo.

Env options
  --reveal                     Print values, which are masked by default
  --scope <all|prod|uat|dev>   Scope to write (default prod; uat = preview)
  --secret                     Mark the variable as a secret on the platform

  \`env set KEY\` with no value reads it from a hidden prompt, or from stdin
  when piped — so a credential need not land in your shell history.

Env import options  (\`env import [file]\`)
  --env <project/environment>  Derive the scope from this environment
  --scope <all|prod|uat|dev>   Scope to write, instead of deriving it
  --secret                     Mark every imported variable secret
  --yes                        Skip the preview and the confirmation

  Upserts: keys in the file are written, keys only on the service are left
  alone. Without --scope the scope follows the environment — UAT for a preview
  one, PROD otherwise — because a variable written to a scope the environment
  never reads looks like a success and behaves like a missing variable.
  Secrets are guessed from the key name and shown before anything is written.

  With no path it reads the .env in this directory. \`launch\` and
  \`services create\` are the opposite: without a terminal they never pick one up
  unless --dotenv names it, so a stray .env in a CI checkout cannot become
  configuration nobody asked for.

  It is --dotenv and not --env-file because Node owns that name from v20.6: it
  loads the file into its own environment and exits before this CLI starts if
  the path is missing. --env-file is still accepted where Node lets it through.

Db options
  --max-rows <n>               Cap rows returned by a query
  --schema <name>              Schema for describe/export, when not the default
  --format <fmt>               dump: sql|archive · export: csv|json|sql
  --yes                        Skip the prompt on an irreversible statement

  \`db shell\` is a REPL; statements end with ';' and \\dt, \\d, \\q work.
  Queries run as the service's own database user and CAN WRITE. DROP, TRUNCATE,
  ALTER and an unfiltered UPDATE/DELETE are confirmed first in a terminal.
  \`db dump\`/\`db export\` print an expiring download URL on stdout.

Login options
  --email <email>              Email, instead of being prompted
  --password <password>        Password, instead of being prompted
  --token <token>              Store an access token you already have (CI)

Init options
  --name/--output/--index      Manifest values, instead of being prompted
  --spa / --no-spa             Serve the entry file for unmatched paths
  --env <project/environment>  Environment the site will be created in
  --yes                        Accept detected defaults instead of prompting
  --force                      Rewrite an existing naijacloud.json

Deploy options
  --name <name>                Site name (first deploy only)
  --output <dir>               Directory to deploy, overriding the manifest
  --index <file>               Entry file, when it is not index.html
  --spa / --no-spa             Serve the entry file for unmatched paths
  --prebuilt                   Skip the manifest's build command
  --new                        Create a new site, ignoring the manifest's serviceId
  --env <project/environment>  Environment to create the site in. Without it the
                               platform places the site itself.
  --yes                        Accept detected defaults instead of prompting
  --no-wait                    Return once queued, without waiting for the build
  --json                       Machine-readable result on stdout

  Configuration is read from naijacloud.json; the first deploy asks for what
  it needs and writes the file, so later runs take no arguments at all.

Redeploy options
  --no-wait                    Return once queued, without waiting for the build
  --json                       Machine-readable result on stdout

  Builds the service's own configured branch — there is no per-deploy branch
  or commit override. Waits by default, and exits non-zero if the build fails,
  so \`${program} redeploy api\` gates a CI job on its own.

Schema options
  --write [path]               Write a local copy and point naijacloud.json at
                               it, for editors that cannot reach the hosted
                               schema (default .naijacloud/schema.json)

Environment
  ${TOKEN_ENV_VAR}            Access token; overrides the stored credentials
  HOSTING_API_BASE_URL         API base URL (default ${DEFAULT_API_BASE_URL})
  HOSTING_API_TIMEOUT_MS       Per-request timeout in ms (default 30000)
  HOSTING_UPLOAD_TIMEOUT_MS    Upload timeout in ms (default 600000)
  NAIJACLOUD_DEPLOY_TIMEOUT_MS Deploy wait timeout in ms (default 900000)

Register with Claude Code
  claude mcp add --transport stdio naijacloud -- ${program} mcp

  Installed as both '${PROGRAM}' and '${ALIAS}'; the two are the same program.
`;
}

const VERSION = CLIENT_VERSION;

interface ParsedArgs {
  flags: Map<string, string>;
  /** Arguments that are not flags or flag values, in order. */
  positionals: string[];
}

/**
 * Minimal `--flag value` / `--flag=value` parser.
 *
 * `booleans` names the flags that take no value, so `naijacloud deploy --spa
 * dist` keeps `dist` as a positional instead of swallowing it as the value of
 * `--spa`.
 */
function parseArgs(args: string[], booleans: ReadonlySet<string> = new Set()): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const equals = arg.indexOf("=");
    if (equals !== -1) {
      flags.set(arg.slice(2, equals), arg.slice(equals + 1));
      continue;
    }

    const name = arg.slice(2);
    const next = args[index + 1];
    if (!booleans.has(name) && next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      index += 1;
    } else {
      flags.set(name, "");
    }
  }

  return { flags, positionals };
}

/** Flags with no value, so the parser leaves the following token alone. */
const INIT_BOOLEANS = new Set(["spa", "no-spa", "yes", "force", "json"]);

const DEPLOY_BOOLEANS = new Set([
  "spa",
  "no-spa",
  "prebuilt",
  "new",
  "yes",
  "wait",
  "no-wait",
  "json",
]);

/**
 * Valueless flags shared by the resource commands.
 *
 * `--service` and `--project` are deliberately absent: they take a value, and
 * listing them here would make `--service api` swallow `api` as a positional.
 */
const RESOURCE_BOOLEANS = new Set([
  "json",
  "yes",
  "reveal",
  "secret",
  "wait",
  "no-wait",
  "no-env-file",
]);

/**
 * Reads a `--x` / `--no-x` pair as a tri-state: explicitly on, explicitly off,
 * or unspecified so a lower-priority source (manifest, detection) decides.
 */
function tristate(flags: Map<string, string>, name: string): boolean | undefined {
  if (flags.has(`no-${name}`)) return false;
  if (flags.has(name)) return true;
  return undefined;
}

/** An optional flag value, with empty treated as absent. */
function value(flags: Map<string, string>, name: string): string | undefined {
  return flags.get(name) || undefined;
}

/**
 * The `.env` to seed a new service from.
 *
 * Spelled `--dotenv` because **Node itself owns `--env-file`** from v20.6: it
 * scans for the flag even after the script path, loads that file into
 * `process.env`, and — when the path does not exist — exits with code 9 before
 * a single line of this CLI runs. Neither behaviour is ours to intercept, so the
 * flag that always works has a name Node does not take.
 *
 * `--env-file` is still accepted, because it is the name people reach for and it
 * does work when the file exists. `--dotenv` wins if both are given.
 */
function dotenvFlag(flags: Map<string, string>): string | undefined {
  return value(flags, "dotenv") ?? value(flags, "env-file");
}

/** A positive integer flag, rejected loudly rather than silently ignored. */
function count(flags: Map<string, string>, name: string): number | undefined {
  const raw = flags.get(name);
  if (raw === undefined || raw === "") return undefined;

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive whole number, not '${raw}'.`);
  }
  return parsed;
}

/**
 * Requires the argument a subcommand cannot run without, naming what it wanted.
 * The message is the only place a user finds the shape of the command without
 * going back to `--help`.
 */
function required(
  argument: string | undefined,
  what: string,
  example: string,
): string {
  if (argument === undefined || argument === "") {
    throw new Error(`${what} is required.\n  ${programName()} ${example}`);
  }
  return argument;
}

/** Rejects an unknown or missing subcommand, listing the ones that exist. */
function unknownSubcommand(command: string, subcommand: string | undefined, valid: string[]): Error {
  const listed = valid.join(", ");
  return new Error(
    subcommand === undefined
      ? `${command} needs a subcommand: ${listed}.\n  ${programName()} ${command} ${valid[0]}`
      : `Unknown ${command} subcommand '${subcommand}'. Use one of: ${listed}.`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const program = programName();

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stderr.write(usage(program));
    process.exitCode = command === undefined ? 1 : 0;
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  switch (command) {
    case "login": {
      const { flags } = parseArgs(rest);
      const options: Parameters<typeof login>[0] = {};

      const email = flags.get("email");
      const password = flags.get("password");
      const token = flags.get("token");
      if (email) options.email = email;
      if (password) options.password = password;
      if (token) options.token = token;

      await login(options);
      return;
    }

    case "logout":
      logout();
      return;

    case "whoami":
      await whoami();
      return;

    case "init": {
      const { flags, positionals } = parseArgs(rest, INIT_BOOLEANS);
      const { init } = await import("./commands/init.js");

      await init({
        dir: positionals[0],
        name: flags.get("name") || undefined,
        output: flags.get("output") || undefined,
        index: flags.get("index") || undefined,
        spa: tristate(flags, "spa"),
        env: value(flags, "env"),
        yes: flags.has("yes"),
        force: flags.has("force"),
        json: flags.has("json"),
      });
      return;
    }

    case "launch": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { launch } = await import("./commands/launch.js");

      await launch({
        dir: positionals[0],
        envFile: dotenvFlag(flags),
        noEnvFile: flags.has("no-env-file"),
        wait: tristate(flags, "wait") ?? true,
      });
      return;
    }

    case "deploy": {
      const { flags, positionals } = parseArgs(rest, DEPLOY_BOOLEANS);
      // Imported lazily so the auth commands never pay to load zod and the
      // archive machinery.
      const { deploy } = await import("./commands/deploy.js");

      await deploy({
        dir: positionals[0],
        name: flags.get("name") || undefined,
        output: flags.get("output") || undefined,
        index: flags.get("index") || undefined,
        spa: tristate(flags, "spa"),
        prebuilt: flags.has("prebuilt"),
        createNew: flags.has("new"),
        env: value(flags, "env"),
        yes: flags.has("yes"),
        json: flags.has("json"),
        wait: tristate(flags, "wait") ?? true,
      });
      return;
    }

    case "redeploy": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { redeploy } = await import("./commands/deployments.js");

      await redeploy({
        // Positional or --service, so both `redeploy api` and
        // `redeploy --service api` work; neither means "whatever this
        // directory is linked to".
        service: positionals[0] ?? value(flags, "service"),
        wait: tristate(flags, "wait") ?? true,
        json: flags.has("json"),
      });
      return;
    }

    // Singular `project` is the interactive view; plural `projects` is the
    // scriptable listing. The two are different jobs, not two spellings.
    case "project": {
      const { positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { projectCommand } = await import("./commands/project.js");

      await projectCommand({ reference: positionals[0] });
      return;
    }

    case "projects": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { projectsCreate, projectsList, projectsShow } = await import(
        "./commands/projects.js"
      );
      const options = { json: flags.has("json") };

      switch (positionals[0]) {
        case "ls":
        case "list":
          await projectsList(options);
          return;
        case "show":
          await projectsShow(
            required(positionals[1], "A project", "projects show <name|id>"),
            options,
          );
          return;
        case "create":
          await projectsCreate(
            required(positionals[1], "A project name", "projects create <name>"),
            {
              ...options,
              team: value(flags, "team"),
              description: value(flags, "description"),
              displayName: value(flags, "display-name"),
            },
          );
          return;
        default:
          throw unknownSubcommand("projects", positionals[0], ["ls", "show", "create"]);
      }
    }

    // Spelled in full, because `env` in this CLI is environment *variables*.
    // The two are different resources and the six extra characters are cheaper
    // than the collision.
    case "environments":
    case "envs": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { environmentsCreate, environmentsList, environmentsRemove } = await import(
        "./commands/environments.js"
      );
      const json = flags.has("json");
      const project = value(flags, "project");

      switch (positionals[0]) {
        case "ls":
        case "list":
          await environmentsList({ project, json });
          return;
        case "create":
          await environmentsCreate(
            required(positionals[1], "An environment name", "environments create <name> --project <p>"),
            { project, json },
          );
          return;
        case "rm":
        case "remove":
          await environmentsRemove(
            required(positionals[1], "An environment", "environments rm <project>/<name>"),
            { yes: flags.has("yes"), json },
          );
          return;
        default:
          throw unknownSubcommand("environments", positionals[0], ["ls", "create", "rm"]);
      }
    }

    case "services": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { servicesCreate, servicesList, servicesShow } = await import(
        "./commands/services.js"
      );
      const options = { json: flags.has("json"), project: value(flags, "project") };

      switch (positionals[0]) {
        case "ls":
        case "list":
          await servicesList(options);
          return;
        case "show":
          await servicesShow(
            required(positionals[1], "A service", "services show <name|id>"),
            options,
          );
          return;
        case "create":
          await servicesCreate(
            required(
              positionals[1],
              "A service name",
              "services create <name> --env <project>/<environment> --repo owner/repo",
            ),
            {
              env: value(flags, "env"),
              repo: value(flags, "repo"),
              branch: value(flags, "branch"),
              type: value(flags, "type"),
              build: value(flags, "build"),
              start: value(flags, "start"),
              port: value(flags, "port"),
              rootDir: value(flags, "root-dir"),
              runtimeVersion: value(flags, "runtime-version"),
              schedule: value(flags, "schedule"),
              healthCheck: value(flags, "health-check"),
              region: value(flags, "region"),
              tier: value(flags, "tier"),
              envFile: dotenvFlag(flags),
              noEnvFile: flags.has("no-env-file"),
              scope: value(flags, "scope"),
              secret: flags.has("secret"),
              wait: tristate(flags, "wait") ?? true,
              json: flags.has("json"),
            },
          );
          return;
        default:
          throw unknownSubcommand("services", positionals[0], ["ls", "show", "create"]);
      }
    }

    case "deployments": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { deploymentsCancel, deploymentsList, deploymentsLogs, deploymentsShow } =
        await import("./commands/deployments.js");
      const json = flags.has("json");

      switch (positionals[0]) {
        case "ls":
        case "list":
          await deploymentsList({
            service: value(flags, "service"),
            project: value(flags, "project"),
            limit: count(flags, "limit"),
            json,
          });
          return;
        case "show":
          await deploymentsShow(
            required(positionals[1], "A deployment id", "deployments show <id>"),
            json,
          );
          return;
        case "logs":
          await deploymentsLogs(
            required(positionals[1], "A deployment id", "deployments logs <id>"),
            { limit: count(flags, "limit"), json },
          );
          return;
        case "cancel":
          await deploymentsCancel(
            required(positionals[1], "A deployment id", "deployments cancel <id>"),
            { yes: flags.has("yes"), json },
          );
          return;
        default:
          throw unknownSubcommand("deployments", positionals[0], ["ls", "show", "logs", "cancel"]);
      }
    }

    // Top-level alias. Cancelling is urgent by nature — a build is burning
    // minutes while you look up the subcommand — so it gets the short spelling.
    case "cancel": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { deploymentsCancel } = await import("./commands/deployments.js");

      await deploymentsCancel(required(positionals[0], "A deployment id", "cancel <id>"), {
        yes: flags.has("yes"),
        json: flags.has("json"),
      });
      return;
    }

    case "env": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { envList, envRemove, envSet } = await import("./commands/env.js");
      const service = value(flags, "service");
      const json = flags.has("json");

      switch (positionals[0]) {
        case "ls":
        case "list":
          await envList({
            service,
            project: value(flags, "project"),
            reveal: flags.has("reveal"),
            json,
          });
          return;
        case "set":
          await envSet(
            required(positionals[1], "A variable name", "env set KEY [VALUE]"),
            // Absent on purpose is a supported case: envSet then reads the
            // value from a hidden prompt or from stdin.
            positionals[2],
            { service, scope: value(flags, "scope"), secret: flags.has("secret"), json },
          );
          return;
        case "rm":
        case "remove":
          await envRemove(required(positionals[1], "A variable name", "env rm KEY"), {
            service,
            yes: flags.has("yes"),
            json,
          });
          return;
        case "import": {
          const { envImport } = await import("./commands/env-import.js");
          await envImport(positionals[1], {
            service,
            env: value(flags, "env"),
            scope: value(flags, "scope"),
            secret: flags.has("secret"),
            yes: flags.has("yes"),
            json,
          });
          return;
        }
        default:
          throw unknownSubcommand("env", positionals[0], ["ls", "set", "rm", "import"]);
      }
    }

    case "domains": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { domainsAdd, domainsList, domainsRemove, domainsVerify } = await import(
        "./commands/domains.js"
      );
      const service = value(flags, "service");
      const json = flags.has("json");

      switch (positionals[0]) {
        case "ls":
        case "list":
          await domainsList({ service, project: value(flags, "project"), json });
          return;
        case "add":
          await domainsAdd(
            required(positionals[1], "A domain", "domains add app.example.com"),
            { service, json },
          );
          return;
        case "verify":
          await domainsVerify(
            required(positionals[1], "A domain", "domains verify app.example.com"),
            { service, json },
          );
          return;
        case "rm":
        case "remove":
          await domainsRemove(
            required(positionals[1], "A domain", "domains rm app.example.com"),
            { service, json, yes: flags.has("yes") },
          );
          return;
        default:
          throw unknownSubcommand("domains", positionals[0], ["ls", "add", "verify", "rm"]);
      }
    }

    case "db": {
      const { flags, positionals } = parseArgs(rest, RESOURCE_BOOLEANS);
      const { dbDescribe, dbDump, dbExport, dbQuery, dbShell, dbTables } = await import(
        "./commands/db.js"
      );
      const options = {
        service: value(flags, "service"),
        json: flags.has("json"),
        maxRows: count(flags, "max-rows"),
        schema: value(flags, "schema"),
        format: value(flags, "format"),
        yes: flags.has("yes"),
      };

      switch (positionals[0]) {
        case "query":
          await dbQuery(
            required(positionals[1], "A statement", 'db query "SELECT 1"'),
            options,
          );
          return;
        case "shell":
          await dbShell(options);
          return;
        case "tables":
          await dbTables(options);
          return;
        case "describe":
          await dbDescribe(
            required(positionals[1], "A table", "db describe <table>"),
            options,
          );
          return;
        case "dump":
          await dbDump(options);
          return;
        case "export":
          await dbExport(
            required(positionals[1], "A table", "db export <table>"),
            options,
          );
          return;
        default:
          throw unknownSubcommand("db", positionals[0], [
            "query",
            "shell",
            "tables",
            "describe",
            "dump",
            "export",
          ]);
      }
    }

    case "schema": {
      const { flags } = parseArgs(rest);
      const { schemaCommand } = await import("./commands/schema.js");
      schemaCommand({ write: flags.get("write") });
      return;
    }

    case "mcp": {
      // Imported lazily so `login`/`logout`/`whoami` never pay to load the MCP SDK.
      const { startMcpServer } = await import("./mcp/server.js");
      await startMcpServer();
      // The stdio transport keeps the process alive; returning here is correct.
      return;
    }

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${usage(program)}`);
      process.exitCode = 1;
      return;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
});
