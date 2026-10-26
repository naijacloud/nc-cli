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
import { isCancelled } from "./terminal.js";

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
      ["rollback <deployment>", "Put an earlier deployment's image back live"],
      ["env ls|set|rm|import", "Environment variables on a service"],
      ["domains ls|add|verify|rm", "Custom domains on a service"],
      ["db query|shell|tables", "SQL console; also describe, dump, export"],
    ],
  ],
  [
    "Argus",
    [
      ["argus sourcemaps upload", "Upload a build's source maps for a release"],
      ["argus deploys new", "Record a deploy, so errors show which release"],
      ["argus test", "Send a test event to check a DSN"],
      ["argus whoami", "Show which source an upload token belongs to"],
    ],
  ],
  [
    "Other",
    [
      ["mcp", "Run the MCP server over stdio"],
      ["--help", "Show this message; <command> --help for one"],
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
  --json                       Machine-readable result on stdout (most commands)
  --yes                        Skip the confirmation prompt
  --limit <n>                  Cap how many rows are returned

  Services and projects are named or referenced by id. Where one name matches
  two services, qualify it as project/name.

Launch options
  --dotenv <path>              Seed the new service from this .env
  --no-env-file                Do not look for or ask about a .env
  --no-wait                    Return once the first build is queued
  --tier <free|starter|pro|pro-max>
                               Size of a web service or cron job (default free)

  Walks team → project → environment → service, creating each level that does
  not exist yet. A web service or cron job is built from a connected GitHub
  repository (for a public git URL or a Docker image, use \`services create\`
  --git or --image); a static site is built here and uploaded. For a service that
  needs configuration it offers the .env it finds, shows what is in it with the
  values masked, and passes it to \`createService\` — so the first build already
  has it, instead of failing and being fixed afterwards.

  A web service or cron job is created Free unless --tier names a size. Each
  account gets one free app; once it is in use, launch asks which paid size to
  use and shows its monthly price. It never picks a paid size for you.

  A free web service sleeps after 15 minutes without visitors and wakes on the
  next visit, in under a minute. Paid sizes never sleep.

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
  One source (required):
  --repo <owner/repo>          GitHub repository, through the NaijaCloud GitHub
                               App (a github.com URL is accepted too)
  --git <https url>            Any public git repository; no GitHub App needed
  --image <reference>          A prebuilt public Docker image, run as-is
  --branch <name>              Branch to build (default: the repo's own)
  --type <web|cron>            Kind of service (default web)
  --schedule <cron>            Cron expression; required for --type cron
  --command <command>          Cron: the command run on each schedule (required
                               unless --image, which can run its own)
  --build <command>            Build command
  --start <command>            Start command (with --image: overrides the
                               image's command)
  --port <n>                   Port the service listens on
  --root-dir <path>            Subdirectory to build, for a monorepo
  --runtime-version <version>  Runtime version, when not the default
  --health-check <path>        HTTP path polled for health
  --region <key>               Region, when not the team's default
  --tier <free|starter|pro|pro-max>
                               Size (default free). Prices: naijacloud.com/pricing
  --dotenv <path>              Seed the service with this .env
  --no-env-file                Do not look for a .env
  --no-wait                    Return once the first build is queued

  The three sources are the dashboard's: a repository the GitHub App can reach,
  any public git URL, or a Docker image. There is no upload-and-build path for a
  web service: local code is either a static site (\`deploy\`) or it is in a
  repository. A database is created from \`${program} project\` → environment →
  + New database.

  Without --tier the service is created Free. Each account gets one free app;
  once it is in use, create fails without creating anything and lists the paid
  sizes with their prices — pass one with --tier. A free web service sleeps
  after 15 minutes without visitors and wakes on the next visit; paid sizes
  never sleep.

Env options
  --reveal                     Print values, which are masked by default
  --scope <all|prod|uat|dev>   Scope to write (default: the service's
                               environment's; uat = preview)
  --secret                     Mark the variable as a secret on the platform

  Without --scope the variable is written at the scope the service's
  environment reads: DEV in an environment called dev, UAT in uat or a preview,
  PROD in prod. A dev environment never receives PROD-scoped variables, so
  defaulting to PROD there would write a variable the app never sees.

  \`env set KEY\` with no value reads it from a hidden prompt, or from stdin
  when piped — so a credential need not land in your shell history. A value
  that starts with -- goes after a lone --:
    ${program} env set NODE_OPTIONS --service api -- --max-old-space-size=4096

Env import options  (\`env import [file]\`)
  --env <project/environment>  Derive the scope from this environment
                               (default: the service's own)
  --scope <all|prod|uat|dev>   Scope to write, instead of deriving it
  --secret                     Mark every imported variable secret
  --yes                        Skip the preview and the confirmation

  Upserts: keys in the file are written, keys only on the service are left
  alone. Without --scope the scope follows the environment — DEV, UAT or PROD
  for an environment of that name, UAT for a preview, PROD otherwise — because
  a variable written to a scope the environment never reads looks like a
  success and behaves like a missing variable.
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
  Queries run as the service's own database user and CAN WRITE. In a terminal,
  DROP, TRUNCATE, ALTER, GRANT/REVOKE and an UPDATE/DELETE with no WHERE are
  confirmed first, in any statement of the input; so is anything the check
  cannot read (an unclosed quote, a DO block). Without a terminal they run, as
  with psql -c; --yes skips the question.
  \`db dump\`/\`db export\` print an expiring download URL on stdout.

Argus options
  --release <version>          The release your app's SDK reports (or ARGUS_RELEASE)
  --url-prefix <prefix>        sourcemaps: where the files are served (default ~/)
  --dry-run                    sourcemaps: list what would be uploaded, send nothing
  --environment <name>         deploys: default ARGUS_ENVIRONMENT, then production
  --commit <sha>               deploys: the commit that was deployed
  --url <link>                 deploys: a link to the deploy
  --dsn <dsn>                  test: the DSN to check (or ARGUS_DSN / SENTRY_DSN)

  sourcemaps, deploys and whoami authenticate with an upload token in
  ARGUS_UPLOAD_TOKEN (argus_up_…), not your login, so they run in CI. Create one
  in Argus on the source, under Upload tokens; it can only upload maps and
  record deploys for that source. test needs only the DSN.

  Each .map under <dir> is named after its file: dist/assets/app.js.map from
  dist is ~/assets/app.js, which matches https://your-site/assets/app.js. Use
  the same --release as the SDK, or Argus cannot match the maps to errors.

Login options
  --email <email>              Email, instead of being prompted
  --password <password>        Password, instead of being prompted
  --token <token>              Store a token or an nc_live_ API key (CI)
  --code <code>                Two-factor code (or a recovery code), instead of
                               being prompted. API keys never need one.

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
  ARGUS_UPLOAD_TOKEN           Argus upload token (argus_up_…) for argus commands
  ARGUS_API_URL                Argus API (default https://argus-api.naijacloud.com)

Help and exit codes
  ${program} <command> --help  Help for one command (also: ${program} help <command>)

  0 success · 1 the command failed · 2 it was typed wrong (unknown option,
  missing value) · 130 cancelled at a prompt. -- ends the options.

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
 * A mistake in how the command was typed: an unknown or misspelt flag, a flag
 * missing its value, a stray argument. Exits 2, the convention for usage
 * errors, so a script can tell it apart from a command that ran and failed.
 */
class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** What one command accepts. */
interface CommandSpec {
  /** Flags that take no value. */
  booleans?: readonly string[];
  /** Flags that take a value. */
  values?: readonly string[];
  /** Value flags whose value may be omitted (`schema --write`). */
  optionalValues?: readonly string[];
  /** The most positional arguments, subcommand included. */
  maxPositionals: number;
  /** First line(s) of `<command> --help`. */
  synopsis: string;
  /** Sections of the full help shown under it. */
  sections?: readonly string[];
}

const COMMANDS: Record<string, CommandSpec> = {
  login: {
    values: ["email", "password", "token", "code"],
    maxPositionals: 0,
    synopsis:
      "login [--email <email> --password <password> [--code <code>]] | [--token <token>]\n\n" +
      "  Prompts for email and password in a terminal. On an account with two-factor\n" +
      "  authentication on it also asks for the code, or takes it from --code.",
    sections: ["Login options"],
  },
  logout: {
    maxPositionals: 0,
    synopsis:
      "logout\n\n  Deletes the stored credentials. The token itself stays valid until it expires.",
  },
  whoami: { booleans: ["json"], maxPositionals: 0, synopsis: "whoami [--json]" },
  init: {
    booleans: ["spa", "no-spa", "yes", "force", "json"],
    values: ["name", "output", "index", "env"],
    maxPositionals: 1,
    synopsis: "init [dir] [options]",
    sections: ["Init options"],
  },
  launch: {
    booleans: ["no-env-file", "wait", "no-wait"],
    values: ["dotenv", "env-file", "tier"],
    maxPositionals: 1,
    synopsis: "launch [dir] [options]",
    sections: ["Launch options"],
  },
  deploy: {
    booleans: ["spa", "no-spa", "prebuilt", "new", "yes", "wait", "no-wait", "json"],
    values: ["name", "output", "index", "env"],
    maxPositionals: 1,
    synopsis: "deploy [dir] [options]",
    sections: ["Deploy options"],
  },
  redeploy: {
    booleans: ["wait", "no-wait", "json"],
    values: ["service"],
    maxPositionals: 1,
    synopsis: "redeploy [service] [options]",
    sections: ["Redeploy options"],
  },
  project: {
    maxPositionals: 1,
    synopsis:
      "project [name|id]\n\n" +
      "  Interactive: browse a project's environments and services, and act on them,\n" +
      "  including + New service and + New database. Needs a terminal.",
  },
  projects: {
    booleans: ["json"],
    values: ["team", "description", "display-name"],
    maxPositionals: 2,
    synopsis: "projects ls | show <name|id> | create <name> [options]",
    sections: ["Resource options", "Projects create options"],
  },
  environments: {
    booleans: ["json", "yes"],
    values: ["project"],
    maxPositionals: 2,
    synopsis:
      "environments ls --project <p> | create <name> --project <p> | rm <project>/<name>",
    sections: ["Environments options"],
  },
  services: {
    booleans: ["json", "no-env-file", "wait", "no-wait", "secret"],
    values: [
      "project", "env", "repo", "git", "image", "branch", "type", "build", "start", "command",
      "port", "root-dir", "runtime-version", "schedule", "health-check", "region", "tier",
      "dotenv", "env-file", "scope",
    ],
    maxPositionals: 2,
    synopsis:
      "services ls [--project <p>] | show <name|id> | create <name> --env <project/environment> <source> [options]",
    sections: ["Resource options", "Services create options"],
  },
  deployments: {
    booleans: ["json", "yes"],
    values: ["service", "project", "limit"],
    maxPositionals: 2,
    synopsis: "deployments ls [--service <s>|--project <p>] | show <id> | logs <id> | cancel <id>",
    sections: ["Resource options"],
  },
  cancel: {
    booleans: ["json", "yes"],
    maxPositionals: 1,
    synopsis:
      "cancel <deployment-id> [--yes] [--json]\n\n" +
      "  Stops an in-flight deployment. To go back to an earlier version, use rollback.",
  },
  rollback: {
    booleans: ["json", "yes", "wait", "no-wait"],
    maxPositionals: 1,
    synopsis:
      "rollback <deployment-id> [--yes] [--no-wait] [--json]\n\n" +
      "  Releases the exact image an earlier successful deployment ran, without\n" +
      "  rebuilding. Find the id with `deployments ls --service <s>`. Waits for it to\n" +
      "  go live and exits non-zero if it does not.",
  },
  env: {
    booleans: ["json", "reveal", "secret", "yes"],
    values: ["service", "project", "scope", "env"],
    maxPositionals: 3,
    synopsis: "env ls | set KEY [VALUE] | rm KEY | import [file]   [--service <s>]",
    sections: ["Resource options", "Env options", "Env import options"],
  },
  domains: {
    booleans: ["json", "yes"],
    values: ["service", "project"],
    maxPositionals: 2,
    synopsis:
      "domains ls | add <domain> | verify <domain> | rm <domain>   [--service <s>]\n\n" +
      "  add prints the DNS records to create. verify exits 1 until the domain is ACTIVE.",
    sections: ["Resource options"],
  },
  db: {
    booleans: ["json", "yes"],
    values: ["service", "max-rows", "schema", "format"],
    maxPositionals: 2,
    synopsis:
      "db query <sql> | shell | tables | describe <table> | dump | export <table>   [--service <s>]",
    sections: ["Resource options", "Db options"],
  },
  argus: {
    booleans: ["json", "dry-run"],
    values: ["release", "url-prefix", "environment", "commit", "url", "dsn"],
    maxPositionals: 3,
    synopsis:
      "argus sourcemaps upload <dir> | deploys new | test | whoami   [--release <v>]\n\n" +
      "  Source maps and deploy markers for Argus, from a build or CI job.",
    sections: ["Argus options"],
  },
  schema: {
    values: ["write"],
    optionalValues: ["write"],
    maxPositionals: 0,
    synopsis: "schema [--write [path]]",
    sections: ["Schema options"],
  },
  mcp: {
    maxPositionals: 0,
    synopsis: "mcp\n\n  Runs the MCP server over stdio, for AI agents.",
    sections: ["Register with Claude Code"],
  },
};
COMMANDS["envs"] = COMMANDS["environments"] as CommandSpec;

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j] as number;
      row[j] = Math.min(
        (row[j] as number) + 1,
        (row[j - 1] as number) + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = current;
    }
  }
  return row[b.length] as number;
}

function suggestion(name: string, known: readonly string[]): string {
  const best = known
    .map((candidate) => ({ candidate, score: distance(name, candidate) }))
    .sort((x, y) => x.score - y.score)[0];
  return best && best.score <= Math.max(2, Math.floor(name.length / 3))
    ? ` (did you mean --${best.candidate}?)`
    : "";
}

/**
 * Parses one command's arguments against what it accepts (TGL-1170).
 *
 *  - `--flag value` / `--flag=value`. A value flag with no value is an error,
 *    so a bare `--service` can never fall back to naijacloud.json's service.
 *  - An unknown flag is an error with a suggestion, never silently dropped:
 *    a misspelt `--servcie api` used to act on the linked service instead.
 *  - `-h` / `--help` anywhere means help; the caller prints it and stops.
 *  - `--` ends the options: everything after it is an argument, so
 *    `env set NODE_OPTIONS -- --max-old-space-size=4096` works.
 *  - Any other `-x` is an error rather than a positional, so `deploy -h`-style
 *    typos cannot become a directory or a project name.
 *  - A token with whitespace in it is an argument even if it starts with `--`
 *    (`db query "-- note\nSELECT 1"`), because no flag name has a space.
 */
function parseArgs(
  command: string,
  args: string[],
  spec: CommandSpec,
): ParsedArgs & { help: boolean } {
  const booleans = new Set(spec.booleans ?? []);
  const values = new Set(spec.values ?? []);
  const optional = new Set(spec.optionalValues ?? []);
  const known = [...booleans, ...values];
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  let help = false;
  let optionsEnded = false;
  const hint = `Run '${programName()} ${command} --help' for usage.`;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;

    if (optionsEnded || arg === "-" || /\s/.test(arg) || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      help = true;
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new UsageError(
        `Unknown option ${arg}. Options are spelled with two dashes; to pass an argument ` +
          `that starts with -, put it after --. ${hint}`,
      );
    }

    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    if (!booleans.has(name) && !values.has(name)) {
      throw new UsageError(
        `Unknown option --${name} for ${command}${suggestion(name, known)}. ${hint}`,
      );
    }

    if (booleans.has(name)) {
      if (equals !== -1) throw new UsageError(`--${name} takes no value. ${hint}`);
      flags.set(name, "");
      continue;
    }

    if (equals !== -1) {
      flags.set(name, arg.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    if (next !== undefined && (!next.startsWith("--") || /\s/.test(next))) {
      flags.set(name, next);
      index += 1;
    } else if (optional.has(name)) {
      flags.set(name, "");
    } else {
      throw new UsageError(
        `--${name} needs a value. For a value that starts with --, write --${name}=<value>. ${hint}`,
      );
    }
  }

  if (!help && positionals.length > spec.maxPositionals) {
    const extra = positionals[spec.maxPositionals];
    throw new UsageError(
      `Unexpected argument '${extra}' for ${command}. Quote a value that has spaces in it. ${hint}`,
    );
  }

  return { flags, positionals, help };
}

/** One titled block of the full help, or "" when there is no such block. */
function helpSection(text: string, title: string): string {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === title || line.startsWith(`${title}  `));
  if (start === -1) return "";
  let end = start + 1;
  while (end < lines.length && (lines[end] === "" || /^\s/.test(lines[end] as string))) end += 1;
  return lines.slice(start, end).join("\n").trimEnd();
}

/** `<command> --help`: its synopsis and the parts of the full help that apply. */
function commandHelp(program: string, command: string): string {
  const spec = COMMANDS[command] as CommandSpec;
  const full = usage(program);
  const sections = (spec.sections ?? [])
    .map((title) => helpSection(full, title))
    .filter((section) => section !== "");
  return (
    `Usage\n  ${program} ${spec.synopsis}\n` +
    (sections.length > 0 ? `\n${sections.join("\n\n")}\n` : "") +
    `\nRun '${program} --help' for every command.\n`
  );
}

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
    throw new UsageError(`${what} is required.\n  ${programName()} ${example}`);
  }
  return argument;
}

/** Rejects an unknown or missing subcommand, listing the ones that exist. */
function unknownSubcommand(command: string, subcommand: string | undefined, valid: string[]): Error {
  const listed = valid.join(", ");
  return new UsageError(
    subcommand === undefined
      ? `${command} needs a subcommand: ${listed}.\n  ${programName()} ${command} ${valid[0]}`
      : `Unknown ${command} subcommand '${subcommand}'. Use one of: ${listed}.`,
  );
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const program = programName();

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    // `help <command>` is that command's help.
    const topic = command === "help" ? rest[0] : undefined;
    if (topic !== undefined && COMMANDS[topic]) {
      process.stdout.write(commandHelp(program, topic));
      return;
    }
    // Asked-for help is the result, so stdout; a bare invocation is a mistake.
    (command === undefined ? process.stderr : process.stdout).write(usage(program));
    process.exitCode = command === undefined ? 2 : 0;
    return;
  }

  if (command === "--version" || command === "-v" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const spec = COMMANDS[command];
  if (spec === undefined) {
    throw new UsageError(
      `Unknown command: ${command}${commandSuggestion(command)}. Run '${program} --help' for the list.`,
    );
  }
  const parsed = parseArgs(command, rest, spec);
  if (parsed.help) {
    process.stdout.write(commandHelp(program, command));
    return;
  }

  switch (command) {
    case "login": {
      const { flags } = parsed;
      const options: Parameters<typeof login>[0] = {};

      const email = flags.get("email");
      const password = flags.get("password");
      const token = flags.get("token");
      const code = flags.get("code");
      if (email) options.email = email;
      if (code) options.code = code;
      if (password) options.password = password;
      if (token !== undefined) options.token = token;

      await login(options);
      return;
    }

    case "logout":
      logout();
      return;

    case "whoami": {
      const { flags } = parsed;
      await whoami({ json: flags.has("json") });
      return;
    }

    case "init": {
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
      const { launch } = await import("./commands/launch.js");

      await launch({
        dir: positionals[0],
        envFile: dotenvFlag(flags),
        noEnvFile: flags.has("no-env-file"),
        wait: tristate(flags, "wait") ?? true,
        tier: value(flags, "tier"),
      });
      return;
    }

    case "deploy": {
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
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
      const { positionals } = parsed;
      const { projectCommand } = await import("./commands/project.js");

      await projectCommand({ reference: positionals[0] });
      return;
    }

    case "projects": {
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
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
              "services create <name> --env <project>/<environment> --repo owner/repo|--git <url>|--image <ref>",
            ),
            {
              env: value(flags, "env"),
              repo: value(flags, "repo"),
              git: value(flags, "git"),
              image: value(flags, "image"),
              command: value(flags, "command"),
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
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
      const { deploymentsCancel } = await import("./commands/deployments.js");

      await deploymentsCancel(required(positionals[0], "A deployment id", "cancel <id>"), {
        yes: flags.has("yes"),
        json: flags.has("json"),
      });
      return;
    }

    case "rollback": {
      const { flags, positionals } = parsed;
      const { rollback } = await import("./commands/deployments.js");
      await rollback(required(positionals[0], "A deployment id", "rollback <deployment-id>"), {
        yes: flags.has("yes"),
        json: flags.has("json"),
        wait: tristate(flags, "wait") ?? true,
      });
      return;
    }

    case "env": {
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
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
      const { flags, positionals } = parsed;
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

    case "argus": {
      const { flags, positionals } = parsed;
      const { argusDeploysNew, argusSourcemapsUpload, argusTest, argusWhoami } = await import(
        "./commands/argus.js"
      );
      const json = flags.has("json");
      const release = value(flags, "release");

      switch (positionals[0]) {
        case "sourcemaps":
          if (positionals[1] !== "upload") {
            throw unknownSubcommand("argus sourcemaps", positionals[1], ["upload"]);
          }
          await argusSourcemapsUpload(
            required(positionals[2], "A folder", "argus sourcemaps upload ./dist --release 1.4.2"),
            { release, urlPrefix: value(flags, "url-prefix"), dryRun: flags.has("dry-run"), json },
          );
          return;
        case "deploys":
          if (positionals[1] !== "new") {
            throw unknownSubcommand("argus deploys", positionals[1], ["new"]);
          }
          await argusDeploysNew({
            release,
            environment: value(flags, "environment"),
            commit: value(flags, "commit"),
            url: value(flags, "url"),
            json,
          });
          return;
        case "test":
          await argusTest({ dsn: value(flags, "dsn"), json });
          return;
        case "whoami":
          await argusWhoami(json);
          return;
        default:
          throw unknownSubcommand("argus", positionals[0], ["sourcemaps", "deploys", "test", "whoami"]);
      }
    }

    case "schema": {
      const { flags } = parsed;
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
      throw new UsageError(`Unknown command: ${command}. Run '${program} --help' for the list.`);
  }
}

/** "did you mean" for a mistyped command. */
function commandSuggestion(command: string): string {
  const best = Object.keys(COMMANDS)
    .map((candidate) => ({ candidate, score: distance(command, candidate) }))
    .sort((x, y) => x.score - y.score)[0];
  return best && best.score <= 2 ? ` (did you mean ${best.candidate}?)` : "";
}

main().catch((error: unknown) => {
  // Backing out of a prompt is an answer, not a failure: nothing to report.
  // Still non-zero (130, as for an interrupted command) so a wrapper script can
  // tell a finished run from an abandoned one.
  if (isCancelled(error)) {
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
});
