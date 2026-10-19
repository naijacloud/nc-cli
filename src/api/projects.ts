/**
 * Teams, projects, environments and services — the resource tree every other
 * operation hangs off.
 */

import { NaijaCloudError, authed, authedList } from "./transport.js";
import { listProjectServices } from "./fields.js";
import { seg, toProject, toServiceSummary, toTeam } from "./v1.js";
import type { V1Environment, V1Project, V1Service, V1Workspace } from "./v1.js";
import type {
  MyService,
  Project,
  ProjectWithTeam,
  ServiceConnection,
  ServiceSummary,
  ServiceType,
  Team,
} from "./types.js";


export async function listTeams(): Promise<Team[]> {
  return (await authedList<V1Workspace>("/workspaces")).map(toTeam);
}

/**
 * Every project the caller can see, tagged with its team.
 *
 * Projects are workspace-scoped, so this resolves the caller's workspaces
 * first and then reads each one's projects, every page, in parallel.
 */
async function projectsAcrossTeams(): Promise<ProjectWithTeam[]> {
  const teams = await listTeams();
  const perTeam = await Promise.all(
    teams.map((team) => authedList<V1Project>(`/workspaces/${seg(team.id)}/projects`)),
  );
  return teams.flatMap((team, index) =>
    (perTeam[index] ?? []).map((project) => ({ ...toProject(project), teamName: team.name })),
  );
}

export async function listProjects(): Promise<ProjectWithTeam[]> {
  return await projectsAcrossTeams();
}

/**
 * Creates a project inside a team.
 *
 * `teamId` is required by the API and has no default, so a caller with more
 * than one team must choose — which is why the interactive flows ask for the
 * team first and the flag-driven ones take `--team`.
 *
 * A new project arrives with whatever environments the platform seeds it with,
 * so the returned `environments` is read rather than assumed: it may be empty,
 * and `createEnvironment` is what fills it.
 */
export async function createProject(input: {
  teamId: string;
  name: string;
  displayName?: string;
  description?: string;
}): Promise<Project> {
  const created = await authed<V1Project>("POST", `/workspaces/${seg(input.teamId)}/projects`, {
    body: { name: input.name, displayName: input.displayName, description: input.description },
  });
  // The create answer may leave out the seeded environments; read them so the
  // caller sees what the platform actually made.
  const environments =
    created.environments ??
    (await authedList<V1Environment>(`/projects/${seg(created.id)}/environments`));
  return toProject({ ...created, environments });
}

/** One `project / environment` pair — a place a service can be created. */
export interface EnvironmentChoice {
  projectId: string;
  projectName: string;
  teamName: string;
  environmentId: string;
  environmentName: string;
  isPreview: boolean;
}

/**
 * Every environment the caller can deploy into, across every project and team.
 *
 * Returned flattened rather than as nested projects because that is the shape
 * the question needs — "where should this live?" is answered with one flat list
 * of pairs, not a project screen followed by an environment screen. Flattening
 * here also keeps the light `{ id name isPreview }` selection from having to
 * masquerade as an `EnvironmentSummary`, which carries services this query
 * deliberately does not ask for.
 */
export async function listEnvironmentChoices(): Promise<EnvironmentChoice[]> {
  const projects = await projectsAcrossTeams();
  const environments = await Promise.all(
    projects.map((project) => authedList<V1Environment>(`/projects/${seg(project.id)}/environments`)),
  );

  return projects.flatMap((project, index) =>
    (environments[index] ?? []).map((environment) => ({
      projectId: project.id,
      projectName: project.name,
      teamName: project.teamName,
      environmentId: environment.id,
      environmentName: environment.name,
      isPreview: environment.isPreview,
    })),
  );
}

/** One project, including its environments and the services inside each. */
export async function getProject(projectId: string): Promise<Project> {
  const [project, tree] = await Promise.all([
    authed<V1Project>("GET", `/projects/${seg(projectId)}`),
    listProjectServices(projectId),
  ]);
  return {
    ...toProject(project),
    environments: tree.map(({ environment, services }) => ({
      id: environment.id,
      name: environment.name,
      isPreview: environment.isPreview,
      services,
    })),
  };
}

/**
 * Every service the caller can reach, flat.
 *
 * One list, no workspace/project/environment walk — which is what makes it the
 * right basis for resolving a service *name* to an id. `listProjects` +
 * `getProject` is the richer but far chattier route.
 */
export async function listMyServices(): Promise<MyService[]> {
  return await authedList<MyService>("/services");
}

/**
 * A project with everything the navigator needs: environments, their
 * region/replica/traffic banner, and the services inside each.
 *
 * Kept separate from `getProject` because the `summary` banner is only worth
 * its cost when something is going to render it.
 */
export async function getProjectTree(projectId: string): Promise<Project> {
  const [project, environments] = await Promise.all([
    authed<V1Project>("GET", `/projects/${seg(projectId)}`),
    authedList<V1Environment>(`/projects/${seg(projectId)}/environments`, { include: "summary" }),
  ]);
  const services = await Promise.all(
    environments.map((environment) =>
      authedList<V1Service>(`/environments/${seg(environment.id)}/services`),
    ),
  );
  return {
    ...toProject(project),
    environments: environments.map((environment, index) => {
      const summary = environment.summary ?? undefined;
      return {
        id: environment.id,
        name: environment.name,
        isPreview: environment.isPreview,
        services: (services[index] ?? []).map(toServiceSummary),
        ...(summary ? { summary } : {}),
      };
    }),
  };
}

/**
 * Connection credentials for a datastore.
 *
 * Null for a service that has none — a web service has no `connection`, and
 * asking for one is a reasonable thing for a caller to do without checking the
 * type first.
 */
export async function getServiceConnection(
  serviceId: string,
): Promise<ServiceConnection | null> {
  try {
    return await authed<ServiceConnection>("GET", `/services/${seg(serviceId)}/connection`);
  } catch (error) {
    // A service with no connection details answers 404 here.
    if (error instanceof NaijaCloudError && error.statusCode === 404 && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export interface ServiceDetail extends ServiceSummary {
  isPreview: boolean;
  environmentId: string;
  environment: { id: string; name: string } | null;
  sourceType: string | null;
  rootDir: string | null;
  buildCommand: string | null;
  startCommand: string | null;
}

/** One service, used to report which environment a deploy will land in. */
export async function getService(serviceId: string): Promise<ServiceDetail> {
  const service = await authed<V1Service>("GET", `/services/${seg(serviceId)}`);
  const environment = await authed<V1Environment>(
    "GET",
    `/environments/${seg(service.environmentId)}`,
  ).catch(() => null);
  return {
    ...toServiceSummary(service),
    isPreview: environment?.isPreview ?? false,
    environmentId: service.environmentId,
    environment: environment ? { id: environment.id, name: environment.name } : null,
    sourceType: service.source?.type ?? null,
    rootDir: service.source?.rootDir ?? null,
    buildCommand: service.build?.buildCommand ?? null,
    startCommand: service.build?.startCommand ?? null,
  };
}
