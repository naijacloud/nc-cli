/**
 * Shared lookups over the resource tree, so a projection lives in one place
 * instead of drifting between the commands that list a resource.
 */

import { authedList } from "./transport.js";
import { seg, toServiceSummary } from "./v1.js";
import type { V1Environment, V1Service } from "./v1.js";
import type { ServiceSummary } from "./types.js";

/** A project's environments, in the order the dashboard shows them. */
export async function listProjectEnvironments(projectId: string): Promise<V1Environment[]> {
  return await authedList<V1Environment>(`/projects/${seg(projectId)}/environments`);
}

/** The services in one environment. */
export async function listEnvironmentServices(environmentId: string): Promise<V1Service[]> {
  return await authedList<V1Service>(`/environments/${seg(environmentId)}/services`);
}

/**
 * Every service in a project, with the environment it lives in. One request
 * for the environments, then one per environment, in parallel.
 */
export async function listProjectServices(
  projectId: string,
): Promise<{ environment: V1Environment; services: ServiceSummary[] }[]> {
  const environments = await listProjectEnvironments(projectId);
  const services = await Promise.all(
    environments.map((environment) => listEnvironmentServices(environment.id)),
  );
  return environments.map((environment, index) => ({
    environment,
    services: (services[index] ?? []).map(toServiceSummary),
  }));
}
