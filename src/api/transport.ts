/**
 * Transport for NaijaCloud's control-plane API: configuration, errors, and the
 * two functions every operation module goes through.
 *
 * NaijaCloud's control plane is a **GraphQL** endpoint at
 * `https://api.naijacloud.com/graphql`, authenticated with
 * `Authorization: Bearer <accessToken>`. There is no REST surface — the paths
 * and operation names below come from the live schema (introspected against
 * the production endpoint), not from guesswork.
 *
 * Resource model, which differs from Vercel's and drives the tool signatures:
 *
 *     Team ──< Project ──< Environment ──< Service ──< Deployment
 *
 * Deployments, custom domains and environment variables all hang off a
 * **Service**, not a Project. Tools therefore take `serviceId`, and accept
 * `projectId` as a convenience that fans out across the project's services in
 * a single nested GraphQL query.
 */

import { createRequire } from "node:module";
import process from "node:process";

import { resolveToken } from "../auth/credentials.js";

export const DEFAULT_API_BASE_URL = "https://api.naijacloud.com";
const GRAPHQL_PATH = "/graphql";
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Replaced with a string literal when the release build bundles the CLI into a
 * standalone binary. It is never declared at runtime, so the `typeof` guard
 * below is what keeps a plain `node build/cli.js` from throwing on it.
 */
declare const __NAIJACLOUD_VERSION__: string | undefined;

/**
 * What CLIENT_VERSION reports when neither source of a version is available.
 * Callers that map a version onto a release artifact — a git tag, say — need to
 * recognise it, because no release was ever cut under this number.
 */
export const UNKNOWN_VERSION = "0.0.0";

/**
 * Single source of truth for the version, shared by the CLI and MCP server.
 *
 * A standalone binary has no package.json beside it, so the build inlines the
 * version; reading package.json is the path an npm install takes.
 */
export const CLIENT_VERSION: string = ((): string => {
  if (typeof __NAIJACLOUD_VERSION__ === "string" && __NAIJACLOUD_VERSION__) {
    return __NAIJACLOUD_VERSION__;
  }
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../../package.json") as { version?: string };
    return pkg.version ?? UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
})();

/** Base URL of the NaijaCloud API, overridable via HOSTING_API_BASE_URL. */
export function apiBaseUrl(): string {
  const override = process.env["HOSTING_API_BASE_URL"]?.trim();
  return (override && override.replace(/\/+$/, "")) || DEFAULT_API_BASE_URL;
}

function graphqlUrl(): string {
  return `${apiBaseUrl()}${GRAPHQL_PATH}`;
}

function timeoutMs(): number {
  const raw = Number(process.env["HOSTING_API_TIMEOUT_MS"]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class NaijaCloudError extends Error {
  readonly code: string | undefined;
  readonly statusCode: number | undefined;

  constructor(message: string, options: { code?: string; statusCode?: number } = {}) {
    super(message);
    this.name = "NaijaCloudError";
    this.code = options.code;
    this.statusCode = options.statusCode;
  }
}

/**
 * Raised before any network call when no credentials can be resolved, and also
 * when the API rejects the credentials we do have. Either way the caller sees
 * an actionable message instead of a bare 401.
 */
export class NotLoggedInError extends NaijaCloudError {
  constructor(message = "Not logged in. Run 'naijacloud login' first.") {
    super(message, { code: "UNAUTHENTICATED", statusCode: 401 });
    this.name = "NotLoggedInError";
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

interface GraphQLError {
  message?: string;
  path?: (string | number)[];
  extensions?: {
    code?: string;
    originalError?: { message?: string | string[]; error?: string; statusCode?: number };
  };
}

interface GraphQLResponse<T> {
  data?: T | null;
  errors?: GraphQLError[];
}

/** GraphQL puts validation detail in extensions.originalError.message (sometimes an array). */
function describe(error: GraphQLError): string {
  const original = error.extensions?.originalError?.message;
  if (Array.isArray(original) && original.length > 0) return original.join("; ");
  if (typeof original === "string" && original) return original;
  return error.message || "Unknown NaijaCloud API error";
}

/**
 * Whether a 400 is the server refusing the operation's shape — a field or
 * argument this CLI sends that the API no longer has. That only happens when
 * the API moved on and this build did not, so it gets its own message.
 */
async function isSchemaMismatch(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as GraphQLResponse<unknown>;
    return (body.errors ?? []).some(
      (error) => error.extensions?.code === "GRAPHQL_VALIDATION_FAILED",
    );
  } catch {
    return false;
  }
}

/**
 * Executes one GraphQL operation. `token` is sent as a bearer credential; when
 * omitted the request is anonymous (only `login` and `signup` allow that).
 */
export async function execute<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const url = graphqlUrl();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `naijacloud-cli/${CLIENT_VERSION}`,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs()),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new NaijaCloudError(
      timedOut
        ? `The NaijaCloud API at ${url} did not answer within ${Math.round(timeoutMs() / 1000)}s. ` +
            "Check your connection and try again, or raise HOSTING_API_TIMEOUT_MS on a slow link."
        : `Cannot reach the NaijaCloud API at ${url}. Check your internet connection and try again.`,
    );
  }

  // The GraphQL endpoint answers 200 even for application errors; a non-2xx
  // here means the gateway or a proxy failed — or that the server refused the
  // operation itself, which Apollo answers with 400 and a JSON body.
  if (!response.ok && response.status !== 200) {
    if (response.status === 401 || response.status === 403) {
      throw new NotLoggedInError(
        "NaijaCloud rejected the stored credentials. Run 'naijacloud login' again.",
      );
    }
    if (response.status === 400 && (await isSchemaMismatch(response))) {
      throw new NaijaCloudError(
        `This version of the CLI (${CLIENT_VERSION}) no longer matches the NaijaCloud API. ` +
          "Update it — npm install -g @naijacloud/cli@latest, or reinstall the way you installed it — and try again.",
        { code: "GRAPHQL_VALIDATION_FAILED", statusCode: 400 },
      );
    }
    throw new NaijaCloudError(
      `NaijaCloud API returned HTTP ${response.status} ${response.statusText}.`,
      { statusCode: response.status },
    );
  }

  let payload: GraphQLResponse<T>;
  try {
    payload = (await response.json()) as GraphQLResponse<T>;
  } catch {
    throw new NaijaCloudError(
      `NaijaCloud API returned a non-JSON response (HTTP ${response.status}).`,
      { statusCode: response.status },
    );
  }

  const firstError = payload.errors?.[0];
  if (firstError) {
    const code = firstError.extensions?.code;
    const statusCode = firstError.extensions?.originalError?.statusCode;

    if (code === "UNAUTHENTICATED" || statusCode === 401) {
      throw new NotLoggedInError(
        "NaijaCloud rejected the credentials (they may have expired). " +
          "Run 'naijacloud login' again.",
      );
    }
    const options: { code?: string; statusCode?: number } = {};
    if (code !== undefined) options.code = code;
    if (statusCode !== undefined) options.statusCode = statusCode;

    if (code === "FORBIDDEN" || statusCode === 403) {
      throw new NaijaCloudError(`Permission denied by NaijaCloud: ${describe(firstError)}`, {
        ...options,
        statusCode: statusCode ?? 403,
      });
    }

    throw new NaijaCloudError(describe(firstError), options);
  }

  if (payload.data == null) {
    throw new NaijaCloudError("NaijaCloud API returned an empty response.");
  }
  return payload.data;
}

/** Executes an operation with the resolved credentials, failing fast if absent. */
export async function authed<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const resolved = resolveToken();
  if (!resolved) throw new NotLoggedInError();
  return await execute<T>(query, variables, resolved.token);
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

/** The largest page the API serves (`OffsetPaginationArgs.limit` is capped at 100). */
export const MAX_PAGE_SIZE = 100;

/** A safety stop, so a server that always reports another page cannot loop us forever. */
const MAX_PAGES = 200;

/** The `{ items pageInfo }` envelope every list query returns. */
export interface OffsetPage<T> {
  items: T[];
  pageInfo: { hasNextPage: boolean };
}

/** The selection a paginated field needs, wrapped around the item selection. */
export function pageSelection(itemSelection: string): string {
  return `items { ${itemSelection} } pageInfo { hasNextPage }`;
}

/**
 * Reads every page of a paginated list query.
 *
 * The query must declare `$page: OffsetPaginationArgs` and pass it to the list
 * field as `OffsetPaginationArgs: $page`; `pick` returns that field's envelope
 * from the response. Pages are read at the maximum size, so a list of up to 100
 * rows is still one request.
 */
export async function authedAllPages<T, D>(
  query: string,
  variables: Record<string, unknown>,
  pick: (data: D) => OffsetPage<T>,
): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await authed<D>(query, { ...variables, page: { page, limit: MAX_PAGE_SIZE } });
    const envelope = pick(data);
    all.push(...envelope.items);
    if (!envelope.pageInfo.hasNextPage) break;
  }
  return all;
}
