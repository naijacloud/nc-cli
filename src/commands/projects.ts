/**
 * `naijacloud projects` — the resource tree, read-only.
 *
 * `ls` is the entry point for someone who knows nothing: it is the only command
 * that needs no argument and no linked directory, and every id another command
 * wants can be reached from what it prints.
 */

import process from "node:process";

import { createProject, getProject, listProjects, listTeams } from "../api/index.js";
import type { EnvironmentSummary, ServiceSummary, Team } from "../api/index.js";
import { formatWhen, printDetail, printJson, printTable } from "../output.js";
import { programName } from "../program-name.js";
import { write } from "../terminal.js";
import { resolveProjectId } from "./resolve.js";

export interface ProjectsOptions {
  json: boolean;
}

export async function projectsList(options: ProjectsOptions): Promise<void> {
  const projects = await listProjects();

  if (options.json) {
    printJson({ count: projects.length, projects });
    return;
  }

  printTable(
    projects,
    [
      { header: "ID", value: (project) => project.id },
      { header: "NAME", value: (project) => project.name },
      { header: "TEAM", value: (project) => project.teamName },
      { header: "REGION", value: (project) => project.region },
      { header: "CREATED", value: (project) => formatWhen(project.createdAt) },
    ],
    "No projects on this account yet. Create one in the dashboard, or run " +
      `\`${programName()} deploy\` to create a static site.`,
  );
}

/**
 * One project, its environments, and the services inside each.
 *
 * Grouped by environment rather than flattened, because "which environment is
 * this service in" is the question that decides whether a deploy is production.
 */
export async function projectsShow(reference: string, options: ProjectsOptions): Promise<void> {
  const project = await getProject(await resolveProjectId(reference));

  if (options.json) {
    printJson(project);
    return;
  }

  printDetail([
    ["id", project.id],
    ["name", project.name],
    ["display name", project.displayName ?? undefined],
    ["description", project.description ?? undefined],
    ["region", project.region],
    ["created", formatWhen(project.createdAt)],
  ]);

  const environments: EnvironmentSummary[] = project.environments ?? [];
  if (environments.length === 0) {
    write("\nNo environments in this project.\n");
    return;
  }

  for (const environment of environments) {
    process.stdout.write(
      `\n${environment.name}${environment.isPreview ? "  (preview)" : ""}\n`,
    );
    printTable(
      environment.services,
      [
        { header: "ID", value: (service: ServiceSummary) => service.id },
        { header: "NAME", value: (service) => service.name },
        { header: "TYPE", value: (service) => service.type },
        { header: "STATUS", value: (service) => service.status },
        { header: "HEALTH", value: (service) => service.health },
        { header: "URL", value: (service) => service.url },
      ],
      "(no services)",
      "  ",
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProjectsCreateOptions extends ProjectsOptions {
  /** Team to create it in, by name or id. Optional when there is only one. */
  team: string | undefined;
  description: string | undefined;
  displayName: string | undefined;
}

/**
 * Picks the team a new project belongs to.
 *
 * `createProject` requires a `teamId` and the schema offers no default, so with
 * more than one team this has to be answered rather than guessed — creating a
 * project in the wrong team is not something the CLI can undo.
 */
export async function resolveTeam(reference: string | undefined): Promise<Team> {
  const teams = await listTeams();
  if (teams.length === 0) {
    throw new Error("This account is not a member of any team, so it cannot own a project.");
  }

  if (reference === undefined) {
    const only = teams[0];
    if (teams.length === 1 && only) return only;
    throw new Error(
      `This account has ${teams.length} teams, so --team is required:\n` +
        teams.map((team) => `  ${team.id}  ${team.name}`).join("\n"),
    );
  }

  const wanted = reference.trim().toLowerCase();
  const found = teams.filter(
    (team) => team.id === reference.trim() || team.name.trim().toLowerCase() === wanted,
  );

  const only = found[0];
  if (found.length === 1 && only) return only;
  if (found.length > 1) {
    throw new Error(
      `'${reference}' matches ${found.length} teams. Use the id:\n` +
        found.map((team) => `  ${team.id}  ${team.name}`).join("\n"),
    );
  }

  throw new Error(
    `No team called '${reference}'. This account belongs to:\n` +
      teams.map((team) => `  ${team.id}  ${team.name}`).join("\n"),
  );
}

/**
 * Creates a project.
 *
 * A project is a container, not a running thing: nothing is deployed and nothing
 * is billed by this. What it may arrive with is environments, which the platform
 * seeds — so the result reports them rather than assuming the project is empty,
 * and only says to create one when it really is.
 */
export async function projectsCreate(
  name: string,
  options: ProjectsCreateOptions,
): Promise<void> {
  const team = await resolveTeam(options.team);

  const input: Parameters<typeof createProject>[0] = { teamId: team.id, name };
  if (options.description !== undefined) input.description = options.description;
  if (options.displayName !== undefined) input.displayName = options.displayName;

  const project = await createProject(input);
  const environments = project.environments ?? [];

  if (options.json) {
    printJson({ ok: true, project, teamName: team.name });
    return;
  }

  printDetail([
    ["id", project.id],
    ["name", project.name],
    ["team", team.name],
    ["region", project.region],
    ["environments", environments.map((environment) => environment.name).join(", ") || "(none)"],
  ]);

  write(
    environments.length === 0
      ? `\nAdd an environment:\n  ${programName()} environments create prod --project ${project.name}\n`
      : `\nDeploy into it:\n  ${programName()} launch\n`,
  );
}
