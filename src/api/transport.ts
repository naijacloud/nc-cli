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

import {
  TOKEN_ENV_VAR,
  deviceId,
  rememberDeviceId,
  resolveToken,
} from "../auth/credentials.js";
import type { ResolvedToken } from "../auth/credentials.js";

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

/** Hosts plain http is allowed to: this machine only. */
function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(\.\d{1,3}){3}$/.test(host)
  );
}

/**
 * The GraphQL endpoint, refusing a base URL a credential must not go to
 * (TGL-1174): one that does not parse, or plain http to anything but this
 * machine. Every request carries a token or a password, so neither is allowed
 * to cross a network in cleartext — the same rule the email SDKs apply.
 */
function graphqlUrl(): string {
  const base = apiBaseUrl();
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new NaijaCloudError(
      `HOSTING_API_BASE_URL is not a valid URL: '${base}'. It should look like ${DEFAULT_API_BASE_URL}.`,
      { code: "BAD_CONFIG" },
    );
  }
  if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
    throw new NaijaCloudError(
      `Refusing to send credentials to ${base} over plain http. Use an https:// URL ` +
        "(http is only allowed for localhost), or unset HOSTING_API_BASE_URL.",
      { code: "BAD_CONFIG" },
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new NaijaCloudError(
      `HOSTING_API_BASE_URL must be an https:// URL, not '${base}'.`,
      { code: "BAD_CONFIG" },
    );
  }
  return `${base}${GRAPHQL_PATH}`;
}

/** A URL's origin (scheme, host, port), or null when it does not parse. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
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

/** Options for {@link execute}. */
export interface ExecuteOptions {
  /**
   * Send this machine's `nc.device` cookie, and keep the one the API sets.
   * Only the sign-in mutations need it: the API decides from it whether to
   * email "New sign-in to your account" (TGL-1171).
   */
  device?: boolean;
}

/** The `nc.device` value in the response's Set-Cookie headers, if any. */
function deviceCookieOf(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.() ?? [];
  for (const cookie of cookies) {
    const match = /^\s*nc\.device=([^;]*)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

/** Reads a GraphQL body from a non-2xx answer, or null when it is not one. */
async function graphqlBody(response: Response): Promise<GraphQLResponse<unknown> | null> {
  try {
    const body = (await response.json()) as GraphQLResponse<unknown>;
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}

/** "Wait 30 seconds" from a Retry-After header, in seconds or as a date. */
function retryAfter(response: Response): string {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return "Wait a minute";
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
  if (!Number.isFinite(seconds) || seconds <= 0) return "Wait a moment";
  return seconds < 120 ? `Wait ${seconds} second${seconds === 1 ? "" : "s"}` : `Wait ${Math.ceil(seconds / 60)} minutes`;
}

/**
 * Executes one GraphQL operation. `token` is sent as a bearer credential; when
 * omitted the request is anonymous (only `login` and `signup` allow that).
 */
export async function execute<T>(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
  options: ExecuteOptions = {},
): Promise<T> {
  const url = graphqlUrl();
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": `naijacloud-cli/${CLIENT_VERSION}`,
  };
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (options.device) headers["cookie"] = `nc.device=${encodeURIComponent(deviceId())}`;

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

  if (options.device) {
    const issued = deviceCookieOf(response);
    if (issued) rememberDeviceId(issued);
  }

  // The GraphQL endpoint answers 200 even for application errors; a non-2xx
  // here means the gateway or a proxy failed — or that the server refused the
  // operation itself, which Apollo answers with 400 and a JSON body.
  if (!response.ok) {
    if (response.status === 429) {
      throw new NaijaCloudError(
        `NaijaCloud is limiting how fast requests are accepted from you (HTTP 429). ${retryAfter(response)} and try again.`,
        { code: "RATE_LIMITED", statusCode: 429 },
      );
    }
    if (response.status === 401 || response.status === 403) {
      // Only the API's own answer says anything about the credentials. A 403
      // HTML page is a firewall, a WAF or a captive portal, and logging in
      // again cannot get past it.
      const body = await graphqlBody(response);
      const codes = (body?.errors ?? []).map((error) => error.extensions?.code);
      if (codes.includes("UNAUTHENTICATED")) {
        throw new NotLoggedInError(
          `NaijaCloud rejected the credentials (they may have expired). Run 'naijacloud login' again.`,
        );
      }
      if (body?.errors?.[0]) {
        throw new NaijaCloudError(`Permission denied by NaijaCloud: ${describe(body.errors[0])}`, {
          code: "FORBIDDEN",
          statusCode: response.status,
        });
      }
      throw new NaijaCloudError(
        `The request was blocked before it reached the NaijaCloud API (HTTP ${response.status} from ${url}). ` +
          "A firewall, proxy, VPN or captive portal on your network is the usual cause — " +
          "try another network. Logging in again will not help.",
        { code: "BLOCKED", statusCode: response.status },
      );
    }
    if (response.status === 400) {
      const body = await graphqlBody(response);
      if ((body?.errors ?? []).some((error) => error.extensions?.code === "GRAPHQL_VALIDATION_FAILED")) {
        throw new NaijaCloudError(
          `This version of the CLI (${CLIENT_VERSION}) no longer matches the NaijaCloud API. ` +
            "Update it — npm install -g @naijacloud/cli@latest, or reinstall the way you installed it — and try again.",
          { code: "GRAPHQL_VALIDATION_FAILED", statusCode: 400 },
        );
      }
      if (body?.errors?.[0]) {
        throw new NaijaCloudError(describe(body.errors[0]), { statusCode: 400 });
      }
    }
    throw new NaijaCloudError(
      `NaijaCloud API returned HTTP ${response.status} ${response.statusText}.` +
        (response.status >= 500 ? " This is on our side; try again in a minute." : ""),
      { statusCode: response.status },
    );
  }

  // Read the text first, so a connection that drops mid-answer is told apart
  // from an answer that is not JSON (a proxy's HTML page).
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new NaijaCloudError(
      "The connection dropped before NaijaCloud finished answering. Check your connection and try again.",
      { code: "CONNECTION_DROPPED", statusCode: response.status },
    );
  }

  let payload: GraphQLResponse<T>;
  try {
    payload = JSON.parse(text) as GraphQLResponse<T>;
  } catch {
    const html = /^\s*</.test(text);
    throw new NaijaCloudError(
      html
        ? `Something between you and NaijaCloud answered with a web page instead of the API (HTTP ${response.status}). ` +
            "A proxy, VPN or captive portal is the usual cause; try another network."
        : `NaijaCloud API returned an answer that is not JSON (HTTP ${response.status}). ` +
            "The connection may have been cut; try again.",
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
    const errorOptions: { code?: string; statusCode?: number } = {};
    if (code !== undefined) errorOptions.code = code;
    if (statusCode !== undefined) errorOptions.statusCode = statusCode;

    if (code === "FORBIDDEN" || statusCode === 403) {
      throw new NaijaCloudError(`Permission denied by NaijaCloud: ${describe(firstError)}`, {
        ...errorOptions,
        statusCode: statusCode ?? 403,
      });
    }

    throw new NaijaCloudError(describe(firstError), errorOptions);
  }

  if (payload.data == null) {
    throw new NaijaCloudError("NaijaCloud API returned an empty response.");
  }
  return payload.data;
}

/**
 * The credentials a request to the configured API may carry, or null when
 * there are none (TGL-1174).
 *
 * A saved login is only ever sent to the origin it was issued for. A login
 * saved before the origin was recorded belongs to the default API. Pointing
 * HOSTING_API_BASE_URL somewhere else (a leftover staging variable, a .envrc,
 * a CI variable) is refused before any request is made: that host needs its
 * own login, or a token passed explicitly in HOSTING_API_TOKEN, which is the
 * user's own choice and goes to whichever https host is configured.
 *
 * The base URL itself is checked first, so a refused URL gets one message.
 */
export function requestToken(): ResolvedToken | null {
  graphqlUrl();
  const resolved = resolveToken();
  if (!resolved || resolved.source !== "file") return resolved;

  const issuedFor = resolved.issuedFor?.trim() || DEFAULT_API_BASE_URL;
  const issuedOrigin = originOf(issuedFor);
  const targetOrigin = originOf(apiBaseUrl());
  if (issuedOrigin === null || issuedOrigin !== targetOrigin) {
    throw new NaijaCloudError(
      `Your saved login belongs to ${issuedOrigin ?? issuedFor}, but HOSTING_API_BASE_URL points at ` +
        `${targetOrigin ?? apiBaseUrl()}, so it was not sent. Run 'naijacloud login' (or ` +
        "'naijacloud login --token <token>') against the new host, or pass a token for it " +
        `explicitly in ${TOKEN_ENV_VAR}. To use your saved login, unset HOSTING_API_BASE_URL.`,
      { code: "LOGIN_FOR_ANOTHER_HOST" },
    );
  }
  return resolved;
}

/** Executes an operation with the resolved credentials, failing fast if absent. */
export async function authed<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const resolved = requestToken();
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
