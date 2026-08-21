/**
 * Environment variables. Values are returned in full by the platform, so any
 * masking is the caller's job.
 */

import { authed } from "./transport.js";
import type {
  EnvVarInput,
  EnvVarMutationResult,
  EnvVarScope,
  ServiceEnvVar,
} from "./types.js";


export async function listEnvVarsByService(serviceId: string): Promise<ServiceEnvVar[]> {
  const data = await authed<{ serviceEnvVars: ServiceEnvVar[] }>(
    `query ServiceEnvVars($serviceId: ID!) { serviceEnvVars(serviceId: $serviceId) { key value scope secret linked } }`,
    { serviceId },
  );
  return data.serviceEnvVars;
}

/**
 * Project-wide listing uses `Service.envVarKeys`, which returns key names only
 * — no values ever leave the platform for this call.
 */
export async function listEnvVarKeysByProject(
  projectId: string,
): Promise<{ serviceId: string; serviceName: string; environmentName: string; keys: string[] }[]> {
  const data = await authed<{
    project: {
      environments: { name: string; services: { id: string; name: string; envVarKeys: string[] }[] }[];
    };
  }>(
    `
      query ProjectEnvVarKeys($id: ID!) {
        project(id: $id) {
          environments { name services { id name envVarKeys } }
        }
      }
    `,
    { id: projectId },
  );

  return data.project.environments.flatMap((environment) =>
    environment.services.map((service) => ({
      serviceId: service.id,
      serviceName: service.name,
      environmentName: environment.name,
      keys: service.envVarKeys,
    })),
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

  const data = await authed<{ setEnvVars: EnvVarMutationResult }>(
    `
      mutation SetEnvVars($serviceId: ID!, $vars: [EnvVarInput!]!) {
        setEnvVars(serviceId: $serviceId, vars: $vars) {
          needsRedeploy
          warnings
          envVars { key value scope secret linked }
        }
      }
    `,
    // Spread so an undefined `secret` is dropped rather than sent as null; the
    // platform treats an explicit null as "not a secret", not as "unspecified".
    { serviceId, vars: vars.map((variable) => ({ ...variable })) },
  );
  return data.setEnvVars;
}

/**
 * Creates or updates a single variable.
 *
 * A thin call through `setEnvVars`, which is the only mutation the platform
 * offers for writing them — there is no single-variable form to prefer.
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
  const data = await authed<{ deleteEnvVar: EnvVarMutationResult }>(
    `
      mutation DeleteEnvVar($serviceId: ID!, $key: String!) {
        deleteEnvVar(serviceId: $serviceId, key: $key) {
          needsRedeploy
          warnings
          envVars { key value scope secret linked }
        }
      }
    `,
    { serviceId, key },
  );
  return data.deleteEnvVar;
}
