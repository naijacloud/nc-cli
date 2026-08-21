/**
 * Turning what a person types into the ids the API wants.
 *
 * Every NaijaCloud operation is keyed by a UUID, which is fine for an agent and
 * miserable at a prompt. So each command takes a *reference*: a UUID, a name, or
 * `project/name` when one name is not enough. Ids are recognised by shape and
 * pass straight through, so the common scripted case costs no extra request.
 *
 * Resolution never guesses. Two services called `api` in different projects
 * produce an error listing both, not a coin flip — picking one would deploy to
 * the wrong environment about half the time.
 */

import { MANIFEST_FILENAME, findManifest, readManifest } from "../deploy-static/manifest.js";
import {
  getProjectTree,
  listEnvironmentChoices,
  listMyServices,
  listProjects,
} from "../api/index.js";
import type { MyService, ProjectWithTeam } from "../api/index.js";
import { programName } from "../program-name.js";

/**
 * The id format the platform issues. Checked so a reference that is already an
 * id skips the lookup entirely — and so a typo'd id is reported as a missing
 * *name*, which is the more useful of the two errors.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function looksLikeId(reference: string): boolean {
  return UUID.test(reference.trim());
}

/** Case-insensitive, whitespace-tolerant comparison for user-typed names. */
function matches(candidate: string, wanted: string): boolean {
  return candidate.trim().toLowerCase() === wanted.trim().toLowerCase();
}

/**
 * Splits an optional `project/name` qualifier off a reference.
 * `acme/api` narrows to the project `acme`; a bare `api` searches everywhere.
 */
function split(reference: string): { project: string | undefined; name: string } {
  const slash = reference.lastIndexOf("/");
  if (slash === -1) return { project: undefined, name: reference };
  return { project: reference.slice(0, slash), name: reference.slice(slash + 1) };
}

/* -------------------------------------------------------------------------- */
/* Services                                                                   */
/* -------------------------------------------------------------------------- */

function ambiguous(reference: string, candidates: MyService[]): Error {
  const lines = candidates
    .map((service) => `  ${service.id}  ${service.projectName}/${service.name}`)
    .join("\n");
  return new Error(
    `'${reference}' matches ${candidates.length} services. Use the id, or qualify ` +
      `it as project/name:\n${lines}`,
  );
}

/**
 * Resolves a service reference to an id.
 *
 * Costs one `myServices` call for a name and nothing at all for an id.
 */
export async function resolveServiceId(reference: string): Promise<string> {
  const trimmed = reference.trim();
  if (trimmed === "") throw new Error("A service is required.");
  if (looksLikeId(trimmed)) return trimmed;

  const { project, name } = split(trimmed);
  const services = await listMyServices();

  const found = services.filter(
    (service) =>
      matches(service.name, name) &&
      (project === undefined || matches(service.projectName, project)),
  );

  if (found.length === 1) return found[0]!.id;
  if (found.length > 1) throw ambiguous(trimmed, found);

  throw new Error(
    `No service called '${trimmed}'. Run \`${programName()} services ls\` to see ` +
      "what this account can reach.",
  );
}

/* -------------------------------------------------------------------------- */
/* Projects                                                                   */
/* -------------------------------------------------------------------------- */

/** Resolves a project reference to an id, by id, name or display name. */
export async function resolveProjectId(reference: string): Promise<string> {
  const trimmed = reference.trim();
  if (trimmed === "") throw new Error("A project is required.");
  if (looksLikeId(trimmed)) return trimmed;

  const projects = await listProjects();
  const found = projects.filter(
    (project) => matches(project.name, trimmed) || matches(project.displayName ?? "", trimmed),
  );

  if (found.length === 1) return found[0]!.id;
  if (found.length > 1) {
    const lines = found
      .map((project: ProjectWithTeam) => `  ${project.id}  ${project.teamName}/${project.name}`)
      .join("\n");
    throw new Error(
      `'${trimmed}' matches ${found.length} projects. Use the id instead:\n${lines}`,
    );
  }

  throw new Error(
    `No project called '${trimmed}'. Run \`${programName()} projects ls\` to see them.`,
  );
}

/* -------------------------------------------------------------------------- */
/* Environments                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Resolves an environment reference to an id.
 *
 * Accepts an id, or `project/environment`. A bare environment name is rejected
 * rather than searched for: "prod" exists in most projects, and picking one by
 * scanning every project would deploy into whichever happened to be found
 * first. The schema offers no environment-by-name lookup to make it safe.
 */
export async function resolveEnvironmentId(reference: string): Promise<string> {
  return (await resolveEnvironment(reference)).id;
}

/** An environment resolved to its id, with the context a caller may also need. */
export interface ResolvedEnvironment {
  id: string;
  /** Null when the reference was an id and the lookup could not be completed. */
  name: string | null;
  projectName: string | null;
  /**
   * Whether this is a preview environment — which decides the scope variables
   * must be written at, since a preview environment reads UAT and nothing else.
   * Defaults to false when it could not be determined.
   */
  isPreview: boolean;
}

/**
 * Resolves an environment reference to its id *and* its properties.
 *
 * The extra lookup exists for one reason: `isPreview` decides which scope an
 * environment variable has to be written at, and a scope chosen wrongly writes
 * successfully into a scope the service never reads — a silent misconfiguration
 * rather than an error.
 *
 * An id resolves through `listEnvironmentChoices`, which is the only query that
 * joins an environment to its project in one request. If that lookup fails or
 * finds nothing, the id is still returned: an environment the caller named
 * explicitly should not be rejected because the *description* of it could not be
 * fetched.
 */
export async function resolveEnvironment(reference: string): Promise<ResolvedEnvironment> {
  const trimmed = reference.trim();
  if (trimmed === "") throw new Error("An environment is required.");

  if (looksLikeId(trimmed)) {
    try {
      const found = (await listEnvironmentChoices()).find(
        (choice) => choice.environmentId === trimmed,
      );
      if (found) {
        return {
          id: trimmed,
          name: found.environmentName,
          projectName: found.projectName,
          isPreview: found.isPreview,
        };
      }
    } catch {
      // Fall through: the id is usable even when the description is not.
    }
    return { id: trimmed, name: null, projectName: null, isPreview: false };
  }

  const { project, name } = split(trimmed);
  if (project === undefined) {
    throw new Error(
      `'${trimmed}' is ambiguous — most projects have an environment by that name. ` +
        "Qualify it as project/environment, or use the environment id:\n" +
        `  ${programName()} deploy --env <project>/${trimmed}`,
    );
  }

  const tree = await getProjectTree(await resolveProjectId(project));
  const found = (tree.environments ?? []).filter((environment) =>
    matches(environment.name, name),
  );

  const only = found[0];
  if (found.length === 1 && only) {
    return {
      id: only.id,
      name: only.name,
      projectName: tree.name,
      isPreview: only.isPreview,
    };
  }
  if (found.length > 1) {
    throw new Error(
      `'${name}' matches ${found.length} environments in ${tree.name}. Use the id:\n` +
        found.map((environment) => `  ${environment.id}  ${environment.name}`).join("\n"),
    );
  }

  const known = (tree.environments ?? []).map((environment) => environment.name).join(", ");
  throw new Error(
    `${tree.name} has no environment called '${name}'.` +
      (known ? ` It has: ${known}.` : " It has none."),
  );
}

/* -------------------------------------------------------------------------- */
/* Defaults from the manifest                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The `serviceId` a `naijacloud.json` in this directory (or a parent) already
 * names, so `njc env ls` works with no arguments where `njc deploy` does.
 *
 * A malformed manifest is not this function's problem to report — the commands
 * that actually deploy do that with a much better message — so a bad file just
 * means "no default" here.
 */
export function serviceIdFromManifest(cwd: string): string | undefined {
  const path = findManifest(cwd);
  if (!path) return undefined;
  try {
    return readManifest(path).manifest.serviceId;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the service a command should act on: the explicit reference if there
 * is one, otherwise whatever this directory is already wired to.
 *
 * `what` names the operation and `example` spells the invocation that would
 * have worked, because the two useful facts in this error are "you are not in a
 * linked directory" and "here is the flag you wanted" — and a generic
 * `<command>` placeholder supplies neither.
 */
export async function requireService(
  reference: string | undefined,
  cwd: string,
  what: string,
  example: string,
): Promise<string> {
  if (reference) return await resolveServiceId(reference);

  const linked = serviceIdFromManifest(cwd);
  if (linked) return linked;

  throw new Error(
    `${what} needs a service. Name one:\n` +
      `  ${programName()} ${example}\n` +
      `Run \`${programName()} services ls\` to list them, or run this from a ` +
      `directory whose ${MANIFEST_FILENAME} names a service.`,
  );
}
