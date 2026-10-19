/**
 * Environment variables. Values are returned in full by the platform, so any
 * masking is the caller's job.
 */

import { authed, authedList } from "./transport.js";
import { listProjectServices } from "./fields.js";
import { seg } from "./v1.js";
import type {
  EnvVarInput,
  EnvVarMutationResult,
  EnvVarScope,
  ServiceEnvVar,
} from "./types.js";


export async function listEnvVarsByService(serviceId: string): Promise<ServiceEnvVar[]> {
  return await authedList<ServiceEnvVar>(`/services/${seg(serviceId)}/env-vars`);
}

/**
 * Project-wide listing reads each service's variables and keeps the key names
 * only, so no value reaches the caller from this call.
 */
export async function listEnvVarKeysByProject(
  projectId: string,
): Promise<{ serviceId: string; serviceName: string; environmentName: string; keys: string[] }[]> {
  const tree = await listProjectServices(projectId);
  return await Promise.all(
    tree.flatMap(({ environment, services }) =>
      services.map(async (service) => ({
        serviceId: service.id,
        serviceName: service.name,
        environmentName: environment.name,
        keys: (await listEnvVarsByService(service.id)).map((variable) => variable.key),
      })),
    ),
  );
}

/**
 * Creates or updates variables in bulk.
 *
 * `setEnvVars` **upserts by key** and leaves every key not mentioned alone, so
 * this is an import rather than a replace — a `.env` with three keys does not
 * wipe the twelve already on the service. Removing one is `deleteEnvVar`.
 *
 * One request for the whole set, which matters beyond politeness: the response
 * carries a single `needsRedeploy`, so the caller tells the user once that the
 * service has to restart, instead of once per variable.
 */
export async function setEnvVars(
  serviceId: string,
  vars: readonly EnvVarInput[],
): Promise<EnvVarMutationResult> {
  if (vars.length === 0) {
    throw new Error("No variables to set.");
  }

  // Spread so an undefined `secret` is dropped rather than sent as null; the
  // platform treats an explicit null as "not a secret", not as "unspecified".
  return await authed<EnvVarMutationResult>("PATCH", `/services/${seg(serviceId)}/env-vars`, {
    body: { envVars: vars.map((variable) => ({ ...variable })) },
  });
}

/**
 * Creates or updates a single variable.
 *
 * A thin call through `setEnvVars`, which is the only write the platform
 * offers for them — there is no single-variable form to prefer.
 */
export async function setEnvVar(
  serviceId: string,
  key: string,
  value: string,
  scope: EnvVarScope,
  secret?: boolean,
): Promise<EnvVarMutationResult> {
  const variable: EnvVarInput = { key, value, scope };
  if (secret !== undefined) variable.secret = secret;
  return await setEnvVars(serviceId, [variable]);
}

/**
 * Removes one variable by key.
 *
 * Returns the same `EnvVarMutationResult` as `setEnvVars`, so the caller learns
 * whether the service has to redeploy before the removal takes effect — a
 * running process keeps the value it started with either way.
 */
export async function deleteEnvVar(
  serviceId: string,
  key: string,
): Promise<EnvVarMutationResult> {
  return await authed<EnvVarMutationResult>(
    "DELETE",
    `/services/${seg(serviceId)}/env-vars/${seg(key)}`,
  );
}
