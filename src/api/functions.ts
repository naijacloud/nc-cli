/**
 * Functions (TGL-1758): one file or folder, one HTTPS URL.
 *
 * A project environment's functions all run inside one hidden web service, the
 * "functions runtime", so a function's build is an ordinary deploy of that
 * service: it is polled and its build log read with the deploy calls the rest
 * of the CLI already uses.
 *
 * The routes mirror the control plane's GraphQL operations one to one
 * (getCloudFunctions, getCloudFunction, createCloudFunctionUpload,
 * deployCloudFunction, deleteCloudFunction), in the `/v1` conventions the
 * static-site routes set: reserve an upload, PUT the zip, then deploy it.
 */

import { authed, authedList } from "./transport.js";
import type { StaticUploadSlot } from "./static-sites.js";
import type { ServiceTier } from "./types.js";
import { seg } from "./v1.js";
import type { V1Deploy } from "./v1.js";

export type CloudFunctionStatus =
  | "DEPLOYING"
  | "LIVE"
  | "SLEEPING"
  | "FAILED"
  | "ERRORING"
  | "STOPPED";

export type CloudFunctionVersionStatus = "DEPLOYING" | "LIVE" | "REPLACED" | "FAILED";

export interface CloudFunctionLimits {
  memoryMb: number;
  maxDurationSeconds: number;
  maxCodeBytes: number;
}

export interface CloudFunctionVersion {
  id: string;
  /** 1, 2, 3 … per function. */
  number: number;
  status: CloudFunctionVersionStatus;
  sizeBytes: number;
  entrypoint: string;
  /** The CLI command that deployed it. */
  command: string | null;
  deployedByName: string | null;
  /** The runtime deploy that carries it; its build log is `getDeploymentLogs`. */
  deployId: string | null;
  /** Plain-English failure reason when FAILED. */
  errorMessage: string | null;
  createdAt: string;
}

export interface CloudFunction {
  id: string;
  name: string;
  /** Always read from the API, never built: the runtime's subdomain can be suffixed. */
  url: string;
  status: CloudFunctionStatus;
  statusDetail: string | null;
  region: string | null;
  tier: ServiceTier;
  /** The hidden web service the function runs in (logs, variables). */
  runtimeServiceId: string;
  environmentId: string;
  liveVersion: CloudFunctionVersion | null;
  latestVersion: CloudFunctionVersion | null;
  /** Null when telemetry is unavailable. */
  calls24h: number | null;
  errors24h: number | null;
  limits: CloudFunctionLimits;
  createdAt: string;
  updatedAt: string;
}

/** Same shape as the static-site slot, so `uploadToPresigned` takes it as is. */
export type CloudFunctionUploadSlot = StaticUploadSlot;

export interface DeployCloudFunctionResult {
  function: CloudFunction;
  version: CloudFunctionVersion;
  deploy: V1Deploy;
}

/** A project's functions; every environment's unless `environmentId` narrows it. */
export async function listCloudFunctions(
  projectId: string,
  options: { environmentId?: string | undefined; search?: string | undefined } = {},
): Promise<CloudFunction[]> {
  return await authedList<CloudFunction>(`/projects/${seg(projectId)}/functions`, {
    environmentId: options.environmentId,
    search: options.search,
  });
}

export async function getCloudFunction(functionId: string): Promise<CloudFunction> {
  return await authed<CloudFunction>("GET", `/functions/${seg(functionId)}`);
}

/**
 * Reserves a presigned PUT for the function's zip. `sizeBytes` is bound into
 * the signature, so the zip must be final before this is called. Omitting
 * `environmentId` means the project's `production` environment.
 */
export async function createCloudFunctionUpload(input: {
  projectId: string;
  environmentId?: string | undefined;
  name: string;
  sizeBytes: number;
}): Promise<CloudFunctionUploadSlot> {
  return await authed<CloudFunctionUploadSlot>("POST", "/function-uploads", { body: input });
}

/** Creates the function on its first deploy, or a new version of it after. */
export async function deployCloudFunction(input: {
  projectId: string;
  environmentId?: string | undefined;
  name: string;
  uploadId: string;
  entrypoint?: string | undefined;
  command?: string | undefined;
}): Promise<DeployCloudFunctionResult> {
  return await authed<DeployCloudFunctionResult>("POST", "/functions", {
    body: input,
    idempotencyKey: `fn-${input.uploadId}`,
  });
}

/** Deletes a function. Its URL stops at once and its logs go with it. */
export async function deleteCloudFunction(functionId: string): Promise<void> {
  await authed<unknown>("DELETE", `/functions/${seg(functionId)}`);
}
