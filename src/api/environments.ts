/**
 * Environments, and creating services inside them.
 *
 * An environment is the level the resource tree hangs its services off —
 * `Project > Environment > Service` — and it is what makes a deploy production
 * or not. Everything here therefore takes an `environmentId`, never a project.
 */

import { authed } from "./transport.js";
import { SERVICE_FIELDS } from "./fields.js";
import type {
  EnvVarInput,
  MonorepoStrategy,
  ServiceSummary,
  ServiceTier,
  ServiceType,
  SourceType,
} from "./types.js";

export interface EnvironmentRef {
  id: string;
  name: string;
}

export async function createEnvironment(
  projectId: string,
  name: string,
): Promise<EnvironmentRef> {
  const data = await authed<{ createEnvironment: EnvironmentRef }>(
    `
      mutation CreateEnvironment($projectId: ID!, $name: String!) {
        createEnvironment(projectId: $projectId, name: $name) { id name }
      }
    `,
    { projectId, name },
  );
  return data.createEnvironment;
}

/** Deletes an environment and everything in it. Returns whether it went. */
export async function deleteEnvironment(environmentId: string): Promise<boolean> {
  const data = await authed<{ deleteEnvironment: boolean }>(
    `mutation DeleteEnvironment($id: ID!) { deleteEnvironment(id: $id) }`,
    { id: environmentId },
  );
  return data.deleteEnvironment;
}

/**
 * Creates a datastore in an environment.
 *
 * There is no `createDatastoreService` mutation despite what the gap analysis
 * claimed — `createService` is the only one, and a datastore is simply the case
 * where `type` is a data type and none of the build/source fields apply. That
 * makes this the small end of a large input: everything else `CreateServiceInput`
 * accepts describes how to build code, which a database does not do.
 *
 * `dbName`, `dbUser` and `dbPassword` are optional; the platform generates
 * them when they are omitted, which is the path worth defaulting to.
 */
export async function createDatastore(input: {
  environmentId: string;
  name: string;
  type: ServiceType;
  region?: string;
  tier?: string;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
}): Promise<ServiceSummary> {
  const data = await authed<{ createService: ServiceSummary }>(
    `
      mutation CreateDatastore($input: CreateServiceInput!) {
        createService(input: $input) { ${SERVICE_FIELDS} }
      }
    `,
    { input },
  );
  return data.createService;
}

/**
 * Creates a static site *inside a chosen environment*, from an uploaded bundle.
 *
 * `deployStaticSite` cannot do this: its input carries no `environmentId`, so
 * it always lands wherever the platform decides. `createService` is the only
 * way to say where a static site belongs, which is why §3.1's pipeline reaches
 * for this whenever a target environment is known.
 */
export async function createStaticService(input: {
  environmentId: string;
  name: string;
  staticUploadId: string;
  staticSpa?: boolean;
  staticIndexPath?: string;
  region?: string;
}): Promise<ServiceSummary> {
  const data = await authed<{ createService: ServiceSummary }>(
    `
      mutation CreateStaticService($input: CreateServiceInput!) {
        createService(input: $input) { ${SERVICE_FIELDS} }
      }
    `,
    { input: { ...input, type: "STATIC" } },
  );
  return data.createService;
}

/**
 * Creates a service that runs code — a web service or a cron job.
 *
 * The counterpart to `createDatastore`: same mutation, the other half of
 * `CreateServiceInput`. Where a datastore fills in almost nothing, this fills in
 * where the code comes from and how to build it.
 *
 * **Source is not optional in practice.** `sourceType` has exactly two members,
 * `GITHUB_APP` and `DOCKER_IMAGE`, and there is no upload variant — so a web
 * service is either a connected repository or a prebuilt image, and local code
 * has no path here at all. Callers that want to ship a directory want
 * `createStaticService`, or `deploy`.
 *
 * `envVars` is the reason this takes configuration rather than being followed by
 * a `setEnvVars` call: the first build starts as soon as the service exists, so
 * variables supplied here are present for it. Setting them afterwards means the
 * first build ran without them.
 */
export async function createRuntimeService(input: {
  environmentId: string;
  name: string;
  /** WEB or CRON. Datastores go through `createDatastore`. */
  type: ServiceType;
  sourceType?: SourceType;
  /** `owner/repo`, for a GITHUB_APP source. */
  repoFullName?: string;
  branch?: string;
  /** Image reference, for a DOCKER_IMAGE source. */
  image?: string;
  buildCommand?: string;
  startCommand?: string;
  runtimeVersion?: string;
  port?: number;
  rootDir?: string;
  watchPaths?: string;
  monorepoStrategy?: MonorepoStrategy;
  /** Cron expression; only meaningful when `type` is CRON. */
  schedule?: string;
  healthCheckPath?: string;
  region?: string;
  tier?: ServiceTier;
  envVars?: EnvVarInput[];
}): Promise<ServiceSummary> {
  const data = await authed<{ createService: ServiceSummary }>(
    `
      mutation CreateRuntimeService($input: CreateServiceInput!) {
        createService(input: $input) { ${SERVICE_FIELDS} }
      }
    `,
    // Undefined keys are dropped by JSON.stringify, so an omitted option never
    // reaches the API as an explicit null — which the schema would treat as
    // "clear this", not "leave it to the platform".
    { input },
  );
  return data.createService;
}
