/**
 * `naijacloud launch` — nothing to something, in one pass.
 *
 * The resource tree is `Team > Project > Environment > Service`, and every level
 * of it has to exist before anything runs. Assembling that by hand is four
 * commands and two ids copied between them; this is the same four operations
 * with the ids carried forward automatically.
 *
 * It is a front door, not a second implementation. Each step calls exactly what
 * the flag-driven commands call — `createProject`, `createEnvironment`,
 * `createAndReport`, `deploy` — so a service made here is indistinguishable from
 * one made by a script, and a fix to either path fixes both.
 *
 * The shape of the last step is dictated by the API rather than chosen: a
 * runtime service is built from a connected repository, and the only thing that
 * accepts local bytes is a static site. So the source question offers a repo or
 * this directory, and the two take genuinely different routes underneath.
 */

import process from "node:process";

import {
  createEnvironment,
  createProject,
  detectBuild,
  getProjectTree,
  githubAppInstallUrl,
  listGithubRepositories,
  listProjects,
  listTeams,
} from "../api/index.js";
import type {
  DetectedBuild,
  EnvironmentSummary,
  InstallationRepo,
  Project,
  ServiceType,
  Team,
} from "../api/index.js";
import { MANIFEST_FILENAME, sanitizeName } from "../deploy-static/manifest.js";
import { heading, requireInteractive, select } from "../interactive.js";
import type { Choice } from "../interactive.js";
import { programName } from "../program-name.js";
import { promptLine, promptWithDefault, promptYesNo, write } from "../terminal.js";
import { collectEnvVars } from "./env-import.js";
import { createAndReport } from "./services.js";
import { serviceIdFromManifest } from "./resolve.js";
import type { RuntimeServiceSpec } from "./services.js";

export interface LaunchOptions {
  /** Directory a static site would be deployed from. Defaults to the cwd. */
  dir: string | undefined;
  /** Skip the `.env` question entirely. */
  noEnvFile: boolean;
  /** `.env` to seed the service with, instead of the one that gets found. */
  envFile: string | undefined;
  wait: boolean;
}

/** Backing out of any prompt aborts the whole flow rather than half-creating. */
class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
  }
}

/** An answer that is allowed to be empty, so the field is simply not sent. */
async function askOptional(label: string, hint: string): Promise<string | undefined> {
  const answer = (await promptLine(`  ${label.padEnd(17)}(${hint}): `)).trim();
  return answer === "" ? undefined : answer;
}

/**
 * Builds a menu row, omitting `hint` when there is nothing to hint.
 *
 * `exactOptionalPropertyTypes` distinguishes an absent optional property from
 * one explicitly set to undefined, so the omission has to be real.
 */
function row<T>(label: string, value: T, hint?: string | null): Choice<T> {
  return hint ? { label, hint, value } : { label, value };
}

/* -------------------------------------------------------------------------- */
/* Step 1 — team                                                              */
/* -------------------------------------------------------------------------- */

async function chooseTeam(): Promise<Team> {
  const teams = await listTeams();
  if (teams.length === 0) {
    throw new Error("This account is not a member of any team, so it cannot own a project.");
  }

  // One team is not a question. Asking it would be a menu with a single row.
  const only = teams[0];
  if (teams.length === 1 && only) return only;

  const picked = await select(
    "Team",
    teams.map((team) => row(team.name, team, team.defaultRegion)),
    { footer: "↑↓ move · ↵ select · q cancel" },
  );
  if (picked === null) throw new Cancelled();

  write(`  Team             ${picked.name}\n`);
  return picked;
}

/* -------------------------------------------------------------------------- */
/* Step 2 — project                                                           */
/* -------------------------------------------------------------------------- */

type ProjectChoice = { kind: "existing"; id: string } | { kind: "new" };

async function chooseProject(team: Team): Promise<Project> {
  const projects = (await listProjects()).filter((project) => project.teamId === team.id);

  const choices: Choice<ProjectChoice>[] = projects.map((project) =>
    row<ProjectChoice>(project.name, { kind: "existing", id: project.id }, project.region),
  );
  choices.push({
    label: "+ New project",
    value: { kind: "new" },
    separated: choices.length > 0,
  });

  const picked = await select("Project", choices, {
    footer: "↑↓ move · ↵ select · q cancel",
  });
  if (picked === null) throw new Cancelled();

  if (picked.kind === "existing") {
    const tree = await getProjectTree(picked.id);
    write(`  Project          ${tree.name}\n`);
    return tree;
  }

  // Checked before sanitising, not after: `sanitizeName` falls back to "site"
  // for an unusable answer, and comparing against that would reject someone who
  // genuinely wants a project called site.
  const typed = (await promptLine("  Project name     : ")).trim();
  if (typed === "") throw new Error("A project name is required.");

  const created = await createProject({ teamId: team.id, name: sanitizeName(typed) });
  write(`  Project          ${created.name}  (created)\n`);

  // Re-read: `createProject` returns a light selection, and the environment
  // step needs the services under each environment to describe them.
  return await getProjectTree(created.id);
}

/* -------------------------------------------------------------------------- */
/* Step 3 — environment                                                       */
/* -------------------------------------------------------------------------- */

type EnvironmentChoiceKind =
  | { kind: "existing"; environment: EnvironmentSummary }
  | { kind: "new" };

async function chooseEnvironment(project: Project): Promise<EnvironmentSummary> {
  const environments = project.environments ?? [];

  const choices: Choice<EnvironmentChoiceKind>[] = environments.map((environment) => {
    const count = environment.services.length;
    const parts = [`${count} service${count === 1 ? "" : "s"}`];
    if (environment.isPreview) parts.push("preview");
    if (environment.summary?.region) parts.push(environment.summary.region);

    return {
      label: environment.name,
      hint: parts.join(" · "),
      value: { kind: "existing" as const, environment },
    };
  });
  choices.push({
    label: "+ New environment",
    value: { kind: "new" },
    separated: choices.length > 0,
  });

  const picked = await select(`Environment in ${project.name}`, choices, {
    footer: "↑↓ move · ↵ select · q cancel",
  });
  if (picked === null) throw new Cancelled();

  if (picked.kind === "existing") {
    write(`  Environment      ${picked.environment.name}\n`);
    return picked.environment;
  }

  const name = (await promptLine("  Environment name : ")).trim();
  if (name === "") throw new Error("An environment name is required.");

  const created = await createEnvironment(project.id, name);
  write(`  Environment      ${created.name}  (created)\n`);

  // A freshly created environment has no services and is not a preview one;
  // constructing the summary here saves a second read of the whole tree.
  return { id: created.id, name: created.name, isPreview: false, services: [] };
}

/* -------------------------------------------------------------------------- */
/* Step 4 — what to put in it                                                 */
/* -------------------------------------------------------------------------- */

type Kind = "web" | "cron" | "static";

async function chooseKind(): Promise<Kind> {
  const picked = await select<Kind>(
    "What are you deploying?",
    [
      {
        label: "Web service",
        hint: "from a GitHub repo · built and run by the platform",
        value: "web",
      },
      {
        label: "Cron job",
        hint: "from a GitHub repo · runs on a schedule",
        value: "cron",
      },
      {
        label: "Static site",
        hint: "from this directory · built locally and uploaded",
        value: "static",
      },
    ],
    { footer: "↑↓ move · ↵ select · q cancel" },
  );
  if (picked === null) throw new Cancelled();
  return picked;
}

/* -------------------------------------------------------------------------- */
/* The repository path                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Picks a repository from the team's GitHub App installation.
 *
 * An empty list is not an error: it means the app is not installed for this
 * team, and the useful response is the install URL rather than a refusal. The
 * flow stops there because installing is a browser round-trip — there is nothing
 * to wait on and nothing sensible to create in the meantime.
 */
async function chooseRepo(teamId: string, teamName: string): Promise<InstallationRepo> {
  const repos = await listGithubRepositories(teamId);

  if (repos.length === 0) {
    let url: string | null = null;
    try {
      url = await githubAppInstallUrl(teamId);
    } catch {
      // Falls through to the generic message below.
    }
    throw new Error(
      `No repositories are connected to ${teamName}.\n` +
        (url
          ? `Install the NaijaCloud GitHub App, then run \`${programName()} launch\` again:\n  ${url}`
          : "Connect a repository in the dashboard, then run this again."),
    );
  }

  const picked = await select(
    "Repository",
    repos.map((repo) =>
      row(
        repo.fullName,
        repo,
        [repo.private ? "private" : "public", repo.defaultBranch]
          .filter((part): part is string => typeof part === "string")
          .join(" · "),
      ),
    ),
    { footer: "↑↓ move · ↵ select · q cancel" },
  );
  if (picked === null) throw new Cancelled();

  write(`  Repository       ${picked.fullName}\n`);
  return picked;
}

/** One line summarising what the platform worked out, when it worked anything out. */
function describeDetection(detected: DetectedBuild | null): string | null {
  if (!detected) return null;
  const parts = [
    detected.framework,
    detected.runtime,
    detected.runtimeVersion,
    detected.packageManager,
  ].filter((part): part is string => typeof part === "string" && part !== "");

  return parts.length > 0 ? parts.join(" · ") : null;
}

async function launchFromRepo(
  teamId: string,
  teamName: string,
  project: Project,
  environment: EnvironmentSummary,
  kind: "web" | "cron",
  options: LaunchOptions,
): Promise<void> {
  const repo = await chooseRepo(teamId, teamName);

  const branch = await promptWithDefault(
    "  Branch          ",
    repo.defaultBranch ?? "main",
  );

  // Advisory only. Detection returns nulls freely, so every answer below still
  // has a local fallback and every one of them is editable at the prompt.
  const detected = await detectBuild({ repoFullName: repo.fullName, branch });
  const summary = describeDetection(detected);
  if (summary) write(`  Detected         ${summary}\n`);

  const defaultName = sanitizeName(repo.fullName.split("/")[1] ?? repo.fullName);
  const name = sanitizeName(await promptWithDefault("  Service name    ", defaultName));

  const rootDir = await askOptional("Root directory", "blank unless it is a monorepo");

  const build =
    detected?.buildCommand != null
      ? await promptWithDefault("  Build command   ", detected.buildCommand)
      : await askOptional("Build command", "blank for none");

  const start =
    detected?.startCommand != null
      ? await promptWithDefault("  Start command   ", detected.startCommand)
      : await askOptional("Start command", "blank to use the platform default");

  let schedule: string | undefined;
  if (kind === "cron") {
    schedule = (await promptLine("  Schedule         (cron, e.g. 0 3 * * *): ")).trim();
    if (schedule === "") throw new Error("A cron job needs a schedule.");
  }

  let port: number | undefined;
  if (kind === "web") {
    // Two prompts rather than one with an empty default: `[]` in brackets reads
    // like a value the field already has, when it means the opposite.
    const answer =
      detected?.port != null
        ? await promptWithDefault("  Port            ", String(detected.port))
        : (await askOptional("Port", "blank to let the platform decide")) ?? "";

    if (answer !== "") {
      const parsed = Number(answer);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        throw new Error(`'${answer}' is not a port number.`);
      }
      port = parsed;
    }
  }

  // Asked last, and only for services that run code: a static site is built
  // here and has no runtime configuration to receive.
  const collected = await collectEnvVars({
    file: options.envFile,
    cwd: process.cwd(),
    interactive: true,
    isPreview: environment.isPreview,
    scope: undefined,
    forceSecret: false,
    skip: options.noEnvFile,
  });

  const spec: RuntimeServiceSpec = {
    environmentId: environment.id,
    name,
    type: (kind === "web" ? "WEB" : "CRON") satisfies ServiceType,
    sourceType: "GITHUB_APP",
    repoFullName: repo.fullName,
    branch,
  };
  if (rootDir !== undefined) spec.rootDir = rootDir;
  if (build !== undefined && build !== "") spec.buildCommand = build;
  if (start !== undefined && start !== "") spec.startCommand = start;
  if (schedule !== undefined) spec.schedule = schedule;
  if (port !== undefined) spec.port = port;
  if (detected?.runtimeVersion != null) spec.runtimeVersion = detected.runtimeVersion;
  if (detected?.monorepoStrategy != null) spec.monorepoStrategy = detected.monorepoStrategy;
  if (collected.vars.length > 0) spec.envVars = collected.vars;

  write(`\nCreating ${name} in ${project.name} / ${environment.name}…\n`);

  await createAndReport(spec, {
    wait: options.wait,
    json: false,
    envSource: collected.source,
    envCount: collected.vars.length,
  });
}

/* -------------------------------------------------------------------------- */
/* The static path                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Hands off to `deploy`, targeted at the environment just chosen.
 *
 * Not reimplemented here: `deploy` owns building, archiving, uploading and
 * writing `naijacloud.json`, and a second copy of that pipeline would be a
 * second set of bugs. Passing the environment id is the whole difference between
 * this and running `deploy` by hand.
 */
async function launchStatic(
  environment: EnvironmentSummary,
  options: LaunchOptions,
): Promise<void> {
  const { deploy } = await import("./deploy.js");

  // `launch` creates, so this passes `--new`. In a directory that already
  // deploys somewhere that would mint a *second* site and repoint the manifest
  // at it, which is a surprising way to lose track of the first — so it is
  // named and confirmed rather than done quietly.
  const linked = serviceIdFromManifest(process.cwd());
  if (linked !== undefined) {
    write(
      `\n${MANIFEST_FILENAME} here already deploys to service ${linked}.\n` +
        `Continuing creates a *new* site in ${environment.name} and repoints the file at it.\n`,
    );
    const confirmed = await promptYesNo("  Create a second site?", false);
    if (!confirmed) {
      write(`To update the existing one instead: ${programName()} deploy\n`);
      throw new Cancelled();
    }
  }

  write("\n");
  await deploy({
    dir: options.dir,
    name: undefined,
    output: undefined,
    index: undefined,
    spa: undefined,
    prebuilt: false,
    createNew: true,
    env: environment.id,
    yes: false,
    json: false,
    wait: options.wait,
  });
}

/* -------------------------------------------------------------------------- */
/* Entry                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The "what goes in this environment" half, on its own.
 *
 * Exported so `naijacloud project` can offer *New service* without growing a
 * second copy of these questions — the navigator has already picked a project
 * and an environment by the time it gets here, which is exactly the state
 * `launch` is in after its first three steps.
 */
export async function addServiceToEnvironment(
  project: Project,
  environment: EnvironmentSummary,
  options: LaunchOptions,
): Promise<void> {
  const kind = await chooseKind();

  if (kind === "static") {
    await launchStatic(environment, options);
    return;
  }

  // Only the repository path needs a team, and only for the two GitHub queries.
  // Resolved by id rather than carried down, so the navigator does not have to
  // know about teams at all.
  let teamName = "this team";
  try {
    const found = (await listTeams()).find((team) => team.id === project.teamId);
    if (found) teamName = found.name;
  } catch {
    // Only affects the wording of an error that may never be shown.
  }

  await launchFromRepo(project.teamId, teamName, project, environment, kind, options);
}

/** The defaults `launch` runs with when it is reached from the navigator. */
export const NAVIGATOR_LAUNCH: LaunchOptions = {
  dir: undefined,
  noEnvFile: false,
  envFile: undefined,
  wait: true,
};

export async function launch(options: LaunchOptions): Promise<void> {
  requireInteractive(
    "launch",
    `${programName()} projects create · environments create · services create    (the same steps, with flags)`,
  );

  heading("launch", "project → environment → service");

  const team = await chooseTeam();
  const project = await chooseProject(team);
  const environment = await chooseEnvironment(project);

  await addServiceToEnvironment(project, environment, options);
}
