/**
 * Static-site deploys: presigned upload, release, and the light reads the
 * deploy command polls with.
 */

import process from "node:process";

import { NaijaCloudError, authed } from "./transport.js";
import type { DeploymentStatus } from "./types.js";


export interface StaticUploadSlot {
  uploadId: string;
  url: string;
  method: string;
  headers: { name: string; value: string }[];
  /** Hard cap on the upload, enforced by the signature. */
  maxBytes: number;
  expiresInSeconds: number;
}

export interface StaticSite {
  id: string;
  name: string;
  status: string;
  url: string | null;
  subdomain: string | null;
  node: { appDomain: string } | null;
}

const STATIC_SITE_FIELDS = `
  id
  name
  status
  url
  subdomain
  node { appDomain }
`;

/**
 * Asks for a one-time presigned PUT slot. `sizeBytes` is bound into the
 * signature, so the archive has to exist — and be final — before this is called.
 */
export async function createStaticUpload(input: {
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<StaticUploadSlot> {
  const data = await authed<{ createStaticUpload: StaticUploadSlot }>(
    `
      mutation CreateStaticUpload($input: StaticUploadInput!) {
        createStaticUpload(StaticUploadInput: $input) {
          uploadId
          url
          method
          headers { name value }
          maxBytes
          expiresInSeconds
        }
      }
    `,
    { input },
  );
  return data.createStaticUpload;
}

/**
 * PUTs the bytes straight to storage.
 *
 * Two rules come from the slot, not from us: echo `headers` verbatim (the
 * content type is part of what was signed, so a mismatch is rejected), and send
 * **no** Authorization header — the credential is in the URL, and adding a
 * bearer token on top makes the request ambiguous to the storage layer.
 *
 * Uploads get their own timeout: the GraphQL default of 30s is right for a
 * control-plane call and far too short for a bundle on a slow link.
 */
export async function uploadToPresigned(slot: StaticUploadSlot, body: Buffer): Promise<void> {
  const headers: Record<string, string> = {};
  for (const header of slot.headers) headers[header.name] = header.value;

  const raw = Number(process.env["HOSTING_UPLOAD_TIMEOUT_MS"]);
  const timeout = Number.isFinite(raw) && raw > 0 ? raw : 600_000;

  let response: Response;
  try {
    response = await fetch(slot.url, {
      method: slot.method,
      headers,
      // Copy into a standalone view: Buffer instances can be slices of a larger
      // pooled ArrayBuffer, which fetch would otherwise send in full.
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new NaijaCloudError(`Upload failed before it completed (${reason}).`);
  }

  if (!response.ok) {
    throw new NaijaCloudError(
      `Storage rejected the upload with HTTP ${response.status} ${response.statusText}. ` +
        "The upload slot may have expired — run the deploy again.",
      { statusCode: response.status },
    );
  }
}

/** Creates a brand-new site from an uploaded bundle and queues its first build. */
export async function deployStaticSite(input: {
  uploadId: string;
  name?: string;
  indexPath?: string;
  spaFallback?: boolean;
}): Promise<{ site: StaticSite; deployment: { id: string; status: DeploymentStatus } }> {
  const data = await authed<{
    deployStaticSite: { site: StaticSite; deployment: { id: string; status: DeploymentStatus } };
  }>(
    `
      mutation DeployStaticSite($input: DeployStaticSiteInput!) {
        deployStaticSite(DeployStaticSiteInput: $input) {
          site { ${STATIC_SITE_FIELDS} }
          deployment { id status }
        }
      }
    `,
    { input },
  );
  return data.deployStaticSite;
}

/**
 * Replaces an existing site's contents in place — same site, same URL, atomic
 * cutover once the new build is healthy.
 */
export async function redeployStaticSite(input: {
  serviceId: string;
  uploadId: string;
  indexPath?: string;
  spaFallback?: boolean;
}): Promise<{ id: string; status: DeploymentStatus }> {
  const data = await authed<{ redeployStaticSite: { id: string; status: DeploymentStatus } }>(
    `
      mutation RedeployStaticSite($input: RedeployStaticSiteInput!) {
        redeployStaticSite(RedeployStaticSiteInput: $input) { id status }
      }
    `,
    { input },
  );
  return data.redeployStaticSite;
}

export async function getStaticSite(serviceId: string): Promise<StaticSite> {
  const data = await authed<{ getService: StaticSite }>(
    `query StaticSite($id: ID!) { getService(id: $id) { ${STATIC_SITE_FIELDS} } }`,
    { id: serviceId },
  );
  return data.getService;
}

/** Light deployment read used while polling; `getDeployment` is the full record. */
export async function getDeploymentStatus(
  deploymentId: string,
): Promise<{ id: string; status: DeploymentStatus; error: string | null }> {
  const data = await authed<{
    getDeployment: { id: string; status: DeploymentStatus; error: string | null };
  }>(`query StaticDeployment($id: ID!) { getDeployment(id: $id) { id status error } }`, {
    id: deploymentId,
  });
  return data.getDeployment;
}

/**
 * The site's live HTTPS URL. `url` is null until the first deploy lands, so
 * fall back to the subdomain and the serving node's domain.
 */
export function siteUrl(site: StaticSite | null | undefined): string | null {
  if (!site) return null;
  if (site.url) return site.url;
  if (site.subdomain && site.node?.appDomain) {
    return `https://${site.subdomain}.${site.node.appDomain}`;
  }
  return null;
}
