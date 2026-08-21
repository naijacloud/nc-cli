/**
 * Teams, projects, environments and services — the resource tree every other
 * operation hangs off.
 */

import { authed } from "./transport.js";
import { PROJECT_FIELDS, SERVICE_FIELDS } from "./fields.js";
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
  const data = await authed<{ myTeams: Team[] }>(`
    query MyTeams { myTeams { id name defaultRegion } }
  `);
  return data.myTeams;
}

/**
 * Every project the caller can see, tagged with its team.
 *
 * `projects` is team-scoped in the schema, so this resolves the caller's teams
 * first and then fetches all teams' projects in **one** aliased query —
 * `selection` is spliced into each alias, so asking for environments too costs
 * nothing beyond a bigger response.
 */
async function projectsAcrossTeams(selection: string): Promise<ProjectWithTeam[]> {
  const teams = await listTeams();
  if (teams.length === 0) return [];

  const aliases = teams
    .map((_, index) => `t${index}: projects(teamId: $team${index}) { ${selection} }`)
    .join("\n");
  const params = teams.map((_, index) => `$team${index}: ID!`).join(", ");

  const variables: Record<string, unknown> = {};
  teams.forEach((team, index) => {
    variables[`team${index}`] = team.id;
  });

  const data = await authed<Record<string, Project[]>>(
    `query AllProjects(${params}) { ${aliases} }`,
    variables,
  );

  return teams.flatMap((team, index) =>
    (data[`t${index}`] ?? []).map((project) => ({ ...project, teamName: team.name })),
  );
}

export async function listProjects(): Promise<ProjectWithTeam[]> {
  return await projectsAcrossTeams(PROJECT_FIELDS);
}

/**
 * Creates a project inside a team.
 *
 * `teamId` is required by the schema and has no default, so a caller with more
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
  const data = await authed<{ createProject: Project }>(
    `
      mutation CreateProject(
        $teamId: ID!
        $name: String!
        $displayName: String
        $description: String
      ) {
        createProject(
          teamId: $teamId
          name: $name
          displayName: $displayName
          description: $description
        ) {
          ${PROJECT_FIELDS}
          environments { id name isPreview }
        }
      }
    `,
    {
      teamId: input.teamId,
      name: input.name,
      displayName: input.displayName ?? null,
      description: input.description ?? null,
    },
  );
  return data.createProject;
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
 * Every environment the caller can deploy into, across every project and team,
 * in **one** request.
 *
 * Returned flattened rather than as nested projects because that is the shape
 * the question needs — "where should this live?" is answered with one flat list
 * of pairs, not a project screen followed by an environment screen. Flattening
 * here also keeps the light `{ id name isPreview }` selection from having to
 * masquerade as an `EnvironmentSummary`, which carries services this query
 * deliberately does not ask for.
 */
export async function listEnvironmentChoices(): Promise<EnvironmentChoice[]> {
  const projects = await projectsAcrossTeams(
    `${PROJECT_FIELDS}
     environments { id name isPreview }`,
  );

  return projects.flatMap((project) =>
    (project.environments ?? []).map((environment) => ({
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
  const data = await authed<{ project: Project }>(
    `
      query GetProject($id: ID!) {
        project(id: $id) {
          ${PROJECT_FIELDS}
          environments {
            id
            name
            isPreview
            services { ${SERVICE_FIELDS} }
          }
        }
      }
    `,
    { id: projectId },
  );
  return data.project;
}

/**
 * Every service the caller can reach, flat.
 *
 * One request, no team/project/environment walk — which is what makes it the
 * right basis for resolving a service *name* to an id. `listProjects` +
 * `getProject` is the richer but far chattier route.
 */
export async function listMyServices(): Promise<MyService[]> {
  const data = await authed<{ myServices: MyService[] }>(`
    query MyServices { myServices { id name projectName type } }
  `);
  return data.myServices;
}

/**
 * A project with everything the navigator needs in one request: environments,
 * their region/replica/traffic banner, and the services inside each.
 *
 * Kept separate from `getProject` because the extra `summary` selection is only
 * worth its cost when something is going to render it.
 */
export async function getProjectTree(projectId: string): Promise<Project> {
  const data = await authed<{ project: Project }>(
    `
      query ProjectTree($id: ID!) {
        project(id: $id) {
          ${PROJECT_FIELDS}
          environments {
            id
            name
            isPreview
            summary { region regionKey replicas trafficStatus }
            services { ${SERVICE_FIELDS} }
          }
        }
      }
    `,
    { id: projectId },
  );
  return data.project;
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
  const data = await authed<{ service: { connection: ServiceConnection | null } }>(
    `
      query ServiceConnection($id: ID!) {
        service(id: $id) {
          connection { scheme host port username password database url externalUrl }
        }
      }
    `,
    { id: serviceId },
  );
  return data.service.connection;
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
  const data = await authed<{ service: ServiceDetail }>(
    `
      query GetService($id: ID!) {
        service(id: $id) {
          ${SERVICE_FIELDS}
          isPreview
          environmentId
          environment { id name }
          sourceType
          rootDir
          buildCommand
          startCommand
        }
      }
    `,
    { id: serviceId },
  );
  return data.service;
}
