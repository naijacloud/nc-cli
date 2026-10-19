/**
 * Environments, and creating services inside them.
 *
 * An environment is the level the resource tree hangs its services off —
 * `Project > Environment > Service` — and it is what makes a deploy production
 * or not. Everything here therefore takes an `environmentId`, never a project.
 */

import { authed } from "./transport.js";
import { seg, toServiceSummary } from "./v1.js";
import type { V1Service } from "./v1.js";
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
  const environment = await authed<EnvironmentRef>(
    "POST",
    `/projects/${seg(projectId)}/environments`,
    { body: { name } },
  );
  return { id: environment.id, name: environment.name };
}

/** Deletes an environment and everything in it. Returns whether it went. */
export async function deleteEnvironment(environmentId: string): Promise<boolean> {
  await authed<void>("DELETE", `/environments/${seg(environmentId)}`);
  return true;
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
  /** Always pass one: omitted, the API creates a paid size. See src/tiers.ts. */
  tier?: ServiceTier;
  dbName?: string;
  dbUser?: string;
  dbPassword?: string;
}): Promise<ServiceSummary> {
  return await createService(input);
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
  return await createService({ ...input, type: "STATIC" });
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
  /** Public https git URL, for a PUBLIC_GIT source. */
  gitUrl?: string;
  /** Image reference, for a DOCKER_IMAGE source. */
  image?: string;
  /** A web service image's command, when not the image's own. */
  imageCommand?: string;
  /** A cron job's scheduled command (blank on an image runs the image's own). */
  command?: string;
  buildCommand?: string;
  startCommand?: string;
  runtimeVersion?: string;
  port?: number;
  rootDir?: string;
  watchPaths?: string[];
  monorepoStrategy?: MonorepoStrategy;
  /** Cron expression; only meaningful when `type` is CRON. */
  schedule?: string;
  healthCheckPath?: string;
  region?: string;
  tier?: ServiceTier;
  envVars?: EnvVarInput[];
}): Promise<ServiceSummary> {
  // Undefined keys are dropped by JSON.stringify, so an omitted option never
  // reaches the API as an explicit null — which the API would treat as
  // "clear this", not "leave it to the platform".
  return await createService(input);
}

/**
 * `POST /v1/environments/{id}/services`, the one create call behind all three
 * kinds above. The environment goes in the path, everything else in the body.
 */
async function createService(
  input: { environmentId: string } & Record<string, unknown>,
): Promise<ServiceSummary> {
  const { environmentId, ...body } = input;
  return toServiceSummary(
    await authed<V1Service>("POST", `/environments/${seg(environmentId)}/services`, { body }),
  );
}
