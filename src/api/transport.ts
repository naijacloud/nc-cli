/**
 * Transport for NaijaCloud's control-plane API: configuration, errors, and the
 * functions every operation module goes through.
 *
 * The CLI speaks NaijaCloud's public **REST** API at
 * `https://api.naijacloud.com/v1` (TGL-1406), authenticated with
 * `Authorization: Bearer <token>`: the session from `naijacloud login`, or a
 * workspace API key in HOSTING_API_TOKEN. Errors come back as
 * `{ error: { code, message, requestId } }`; lists as `{ data, nextCursor }`.
 * GraphQL is the dashboard's private API and the CLI no longer uses it.
 *
 * Resource model, which differs from Vercel's and drives the tool signatures:
 *
 *     Workspace ──< Project ──< Environment ──< Service ──< Deploy
 *
 * Deploys, custom domains and environment variables all hang off a
 * **Service**, not a Project. Tools therefore take `serviceId`, and accept
 * `projectId` as a convenience that fans out across the project's services.
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
const V1_PATH = "/v1";
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
 * The REST API root (`<base>/v1`), refusing a base URL a credential must not go to
 * (TGL-1174): one that does not parse, or plain http to anything but this
 * machine. Every request carries a token or a password, so neither is allowed
 * to cross a network in cleartext — the same rule the email SDKs apply.
 */
function apiV1Url(): string {
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
  return `${base}${V1_PATH}`;
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
  /** The API's `x-request-id` for this failure; quote it to support. */
  readonly requestId: string | undefined;

  constructor(
    message: string,
    options: { code?: string | undefined; statusCode?: number; requestId?: string | undefined } = {},
  ) {
    super(message);
    this.name = "NaijaCloudError";
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.requestId = options.requestId;
  }
}

/**
 * Raised before any network call when no credentials can be resolved, and also
 * when the API rejects the credentials we do have. Either way the caller sees
 * an actionable message instead of a bare 401.
 */
export class NotLoggedInError extends NaijaCloudError {
  constructor(message = "Not logged in. Run 'naijacloud login' first.", requestId?: string) {
    super(message, { code: "UNAUTHENTICATED", statusCode: 401, requestId });
    this.name = "NotLoggedInError";
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                  */
/* -------------------------------------------------------------------------- */

/** The `/v1` error envelope: `{ error: { code, message, requestId } }`. */
interface ErrorEnvelope {
  error?: { code?: string; message?: string; requestId?: string };
}

/** Options for {@link execute}. */
export interface ExecuteOptions {
  /** JSON request body. */
  body?: unknown;
  /** Query string parameters; undefined values are left out. */
  query?: Record<string, string | number | boolean | undefined>;
  /**
   * Send this machine's device id, and keep the one the API answers with.
   * Only the sign-in calls need it: the API decides from it whether to email
   * "New sign-in to your account" (TGL-1171).
   */
  device?: boolean;
  /**
   * `Idempotency-Key` for a POST that creates something or starts work, so a
   * retry after a dropped connection cannot do it twice.
   */
  idempotencyKey?: string;
}

/** The device id the API issued, from its header or (older APIs) its cookie. */
function issuedDeviceId(response: Response): string | undefined {
  const header = response.headers.get("x-device-id")?.trim();
  if (header) return header;
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  for (const cookie of headers.getSetCookie?.() ?? []) {
    const match = /^\s*nc\.device=([^;]*)/.exec(cookie);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

/** Reads the error envelope from an answer, or null when it is not one. */
function envelopeOf(text: string): ErrorEnvelope["error"] | null {
  try {
    const body = JSON.parse(text) as ErrorEnvelope;
    return body && typeof body === "object" && body.error && typeof body.error === "object"
      ? body.error
      : null;
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

/** " (request id: …)", so a user can quote it to support. */
function withRequestId(message: string, requestId: string | undefined): string {
  return requestId ? `${message} (request id: ${requestId})` : message;
}

/** Builds `<base>/v1<path>?<query>`. */
function urlFor(path: string, query: ExecuteOptions["query"]): string {
  const url = new URL(`${apiV1Url()}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/**
 * Sends one request to the REST API at `/v1`. `token` is sent as a bearer
 * credential; when omitted the request is anonymous (only signing in and the
 * public price list allow that). Answers `undefined` for `204 No Content`.
 */
export async function execute<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  token?: string,
  options: ExecuteOptions = {},
): Promise<T> {
  const url = urlFor(path, options.query);
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": `naijacloud-cli/${CLIENT_VERSION}`,
  };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (options.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
  if (options.device) {
    const id = deviceId();
    headers["x-device-id"] = id;
    headers["cookie"] = `nc.device=${encodeURIComponent(id)}`;
  }

  let response: Response;
  try {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(timeoutMs()) };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    response = await fetch(url, init);
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new NaijaCloudError(
      timedOut
        ? `The NaijaCloud API at ${apiBaseUrl()} did not answer within ${Math.round(timeoutMs() / 1000)}s. ` +
            "Check your connection and try again, or raise HOSTING_API_TIMEOUT_MS on a slow link."
        : `Cannot reach the NaijaCloud API at ${apiBaseUrl()}. Check your internet connection and try again.`,
    );
  }

  if (options.device) {
    const issued = issuedDeviceId(response);
    if (issued) rememberDeviceId(issued);
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

  if (!response.ok) {
    const error = envelopeOf(text);
    const requestId = error?.requestId ?? response.headers.get("x-request-id") ?? undefined;
    const message = error?.message?.trim();

    if (response.status === 429) {
      throw new NaijaCloudError(
        withRequestId(
          `NaijaCloud is limiting how fast requests are accepted from you (HTTP 429). ${retryAfter(response)} and try again.`,
          requestId,
        ),
        { code: "RATE_LIMITED", statusCode: 429, requestId },
      );
    }
    // Only the API's own envelope says anything about the credentials. An
    // HTML 401/403 is a firewall, a WAF or a captive portal, and logging in
    // again cannot get past it.
    if (!error && (response.status === 401 || response.status === 403)) {
      throw new NaijaCloudError(
        `The request was blocked before it reached the NaijaCloud API (HTTP ${response.status} from ${apiBaseUrl()}). ` +
          "A firewall, proxy, VPN or captive portal on your network is the usual cause — " +
          "try another network. Logging in again will not help.",
        { code: "BLOCKED", statusCode: response.status },
      );
    }
    if (error?.code === "UNAUTHENTICATED" || response.status === 401) {
      throw new NotLoggedInError(
        "NaijaCloud rejected the credentials (they may have expired). Run 'naijacloud login' again.",
        requestId,
      );
    }
    if (error?.code === "FORBIDDEN" || response.status === 403) {
      throw new NaijaCloudError(
        withRequestId(`Permission denied by NaijaCloud: ${message || "you do not have access to this."}`, requestId),
        { code: "FORBIDDEN", statusCode: response.status, requestId },
      );
    }
    // A 404 or 405 with no envelope is a route this API does not have: the CLI
    // is older (or newer) than the API it is talking to.
    if (!error && (response.status === 404 || response.status === 405)) {
      throw new NaijaCloudError(
        `This version of the CLI (${CLIENT_VERSION}) no longer matches the NaijaCloud API. ` +
          "Update it — npm install -g @naijacloud/cli@latest, or reinstall the way you installed it — and try again.",
        { code: "API_MISMATCH", statusCode: response.status },
      );
    }
    if (message) {
      throw new NaijaCloudError(withRequestId(message, requestId), {
        code: error?.code,
        statusCode: response.status,
        requestId,
      });
    }
    if (/^\s*</.test(text)) {
      throw new NaijaCloudError(
        `Something between you and NaijaCloud answered with a web page instead of the API (HTTP ${response.status}). ` +
          "A proxy, VPN or captive portal is the usual cause; try another network.",
        { statusCode: response.status },
      );
    }
    throw new NaijaCloudError(
      withRequestId(
        `NaijaCloud API returned HTTP ${response.status} ${response.statusText}.` +
          (response.status >= 500 ? " This is on our side; try again in a minute." : ""),
        requestId,
      ),
      { statusCode: response.status, requestId },
    );
  }

  if (response.status === 204 || text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
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
  apiV1Url();
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

/** Sends a request with the resolved credentials, failing fast if there are none. */
export async function authed<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  options: ExecuteOptions = {},
): Promise<T> {
  const resolved = requestToken();
  if (!resolved) throw new NotLoggedInError();
  return await execute<T>(method, path, resolved.token, options);
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

/** The largest page the API serves (`limit` is capped at 100). */
export const MAX_PAGE_SIZE = 100;

/** A safety stop, so a server that always reports another page cannot loop us forever. */
const MAX_PAGES = 200;

/** The `{ data, nextCursor }` envelope every `/v1` list returns. */
export interface ListPage<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Reads every page of a `/v1` list by following `nextCursor`. Pages are read
 * at the maximum size, so a list of up to 100 rows is still one request.
 */
export async function authedList<T>(
  path: string,
  query: ExecuteOptions["query"] = {},
): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result: ListPage<T> = await authed<ListPage<T>>("GET", path, {
      query: cursor ? { ...query, cursor } : { ...query, limit: MAX_PAGE_SIZE },
    });
    all.push(...result.data);
    cursor = result.nextCursor;
    if (!cursor) break;
  }
  return all;
}
