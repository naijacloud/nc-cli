/**
 * `naijacloud argus` — the build-time half of Argus: upload source maps, mark a
 * deploy, and check a DSN with a test event.
 *
 * Not the platform API. These talk to Argus's own host with an **upload
 * token** (`argus_up_…`, made on the source in Argus), the same contract as the
 * standalone `@naijacloud/argus-cli` (argus.sdk/1 §9). That is deliberate: they
 * run in CI, where nobody has run `login`, and an upload token can only upload
 * maps and record deploys for one source, so a leaked build secret reads
 * nothing. The token comes from the environment only, never a flag, so it
 * stays out of shell history and CI logs.
 */

import { randomBytes } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

import { CLIENT_VERSION } from "../api/index.js";
import { printJson } from "../output.js";
import { programName } from "../program-name.js";
import { write } from "../terminal.js";

export const UPLOAD_TOKEN_ENV_VAR = "ARGUS_UPLOAD_TOKEN";
export const DEFAULT_ARGUS_API_URL = "https://argus-api.naijacloud.com";

/** Argus refuses anything larger, so a map over it fails here, not after the upload. */
const MAX_MAP_BYTES = 16 << 20;

/** Uploads in flight at once: enough to hide latency, few enough to stay polite. */
const UPLOAD_CONCURRENCY = 4;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function apiBase(): string {
  return (env("ARGUS_API_URL") ?? DEFAULT_ARGUS_API_URL).replace(/\/+$/, "");
}

function uploadToken(): string {
  const token = env(UPLOAD_TOKEN_ENV_VAR);
  if (!token) {
    throw new Error(
      `Set ${UPLOAD_TOKEN_ENV_VAR} to an upload token. Create one in Argus: Sources → the source → Upload tokens.`,
    );
  }
  if (!token.startsWith("argus_up_")) {
    throw new Error(`${UPLOAD_TOKEN_ENV_VAR} should start with argus_up_. A DSN is not an upload token.`);
  }
  return token;
}

interface ArgusResponse {
  status: number;
  body: Record<string, unknown>;
}

async function call(method: string, path: string, body?: string): Promise<ArgusResponse> {
  const token = uploadToken();
  const base = apiBase();
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      ...(body !== undefined ? { body } : {}),
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": `naijacloud-cli/${CLIENT_VERSION}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
    });
  } catch (error) {
    throw new Error(`Couldn't reach ${base}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    // An empty or non-JSON body; the status says enough.
  }
  if (res.status === 401) {
    throw new Error("Argus refused the upload token. It may have been revoked; create a new one on the source in Argus.");
  }
  return { status: res.status, body: parsed };
}

function reason(response: ArgusResponse): string {
  return typeof response.body["error"] === "string" ? response.body["error"] : `HTTP ${response.status}`;
}

/* -------------------------------------------------------------------------- */
/* Source maps                                                                */
/* -------------------------------------------------------------------------- */

async function findMaps(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await findMaps(path)));
    else if (entry.isFile() && entry.name.endsWith(".map")) found.push(path);
  }
  return found.sort();
}

/**
 * The name Argus matches a stack frame's URL against: `dist/assets/app.js.map`
 * uploaded from `dist` is `~/assets/app.js`, which matches
 * `https://any-host/assets/app.js`.
 */
export function artifactName(root: string, mapPath: string, prefix: string): string {
  const rel = relative(root, mapPath).split(sep).join("/").replace(/\.map$/, "");
  return `${prefix.endsWith("/") ? prefix : `${prefix}/`}${rel}`;
}

export interface SourcemapsUploadOptions {
  release: string | undefined;
  urlPrefix: string | undefined;
  dryRun: boolean;
  json: boolean;
}

export async function argusSourcemapsUpload(dir: string, options: SourcemapsUploadOptions): Promise<void> {
  const release = options.release ?? env("ARGUS_RELEASE");
  if (!release) {
    throw new Error("--release is required (or set ARGUS_RELEASE): the same release your app's SDK reports.");
  }
  const prefix = options.urlPrefix ?? "~/";

  const info = await stat(dir).catch(() => undefined);
  if (!info) throw new Error(`${dir} doesn't exist.`);
  if (!info.isDirectory()) throw new Error(`${dir} isn't a folder.`);

  const maps = await findMaps(dir);
  if (maps.length === 0) {
    throw new Error(
      `No .map files under ${dir}. Turn on source maps in your build (Vite: build.sourcemap: true; webpack: devtool: 'source-map').`,
    );
  }

  if (options.dryRun) {
    const planned = maps.map((path) => ({ name: artifactName(dir, path, prefix), file: relative(dir, path) }));
    if (options.json) printJson({ release, dryRun: true, maps: planned });
    else for (const map of planned) process.stdout.write(`would upload ${map.name}  (${map.file})\n`);
    return;
  }

  // Uploads in a stable order for the report, whichever finishes first.
  const results: { name: string; uploaded: boolean; error?: string }[] = maps.map((path) => ({
    name: artifactName(dir, path, prefix),
    uploaded: false,
  }));
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < maps.length; i = next++) {
      const result = results[i]!;
      const body = await readFile(maps[i]!, "utf8");
      if (Buffer.byteLength(body) > MAX_MAP_BYTES) {
        result.error = "larger than 16 MB";
        continue;
      }
      const response = await call(
        "POST",
        `/v1/cli/sourcemaps?release=${encodeURIComponent(release)}&name=${encodeURIComponent(result.name)}`,
        body,
      );
      if (response.status === 201) {
        result.uploaded = true;
        if (!options.json) write(`✓ ${result.name}\n`);
      } else {
        result.error = reason(response);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, maps.length) }, worker));

  const failed = results.filter((result) => !result.uploaded);
  if (options.json) {
    printJson({ release, uploaded: maps.length - failed.length, total: maps.length, maps: results });
  } else {
    for (const result of failed) write(`✗ ${result.name}: ${result.error}\n`);
    process.stdout.write(`${maps.length - failed.length} of ${maps.length} source maps uploaded for release ${release}.\n`);
  }
  if (failed.length > 0) {
    throw new Error(`${failed.length} source map${failed.length === 1 ? " was" : "s were"} not uploaded.`);
  }
}

/* -------------------------------------------------------------------------- */
/* Deploys                                                                    */
/* -------------------------------------------------------------------------- */

export interface DeploysNewOptions {
  release: string | undefined;
  environment: string | undefined;
  commit: string | undefined;
  url: string | undefined;
  json: boolean;
}

export async function argusDeploysNew(options: DeploysNewOptions): Promise<void> {
  const release = options.release ?? env("ARGUS_RELEASE");
  if (!release) throw new Error("--release is required (or set ARGUS_RELEASE).");
  const body = {
    release,
    environment: options.environment ?? env("ARGUS_ENVIRONMENT") ?? "production",
    ...(options.commit ? { commitSha: options.commit } : {}),
    ...(options.url ? { url: options.url } : {}),
  };
  const response = await call("POST", "/v1/cli/deploys", JSON.stringify(body));
  if (response.status !== 201) throw new Error(`Argus didn't record the deploy: ${reason(response)}`);
  if (options.json) {
    printJson({ recorded: true, ...body, source: response.body["source"] ?? null });
    return;
  }
  process.stdout.write(
    `✓ Deploy of ${release} to ${body.environment} recorded for ${String(response.body["source"] ?? "the source")}.\n`,
  );
}

/* -------------------------------------------------------------------------- */
/* Whoami                                                                     */
/* -------------------------------------------------------------------------- */

export async function argusWhoami(json: boolean): Promise<void> {
  const response = await call("GET", "/v1/cli/whoami");
  if (response.status !== 200) throw new Error(reason(response));
  const source = (response.body["source"] ?? {}) as { id?: string; name?: string };
  if (json) {
    printJson({ source });
    return;
  }
  process.stdout.write(`This token uploads for ${source.name ?? "?"} (${source.id ?? "?"}).\n`);
}

/* -------------------------------------------------------------------------- */
/* Test event                                                                 */
/* -------------------------------------------------------------------------- */

/** `https://<key>@<host>/<project>`, or null when it is not a DSN. */
export function parseDsn(raw: string): { key: string; origin: string; project: string } | null {
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const project = parts.pop();
    if (!url.username || !project || !/^\d+$/.test(project)) return null;
    return {
      key: decodeURIComponent(url.username),
      origin: `${url.protocol}//${url.host}${parts.length ? `/${parts.join("/")}` : ""}`,
      project,
    };
  } catch {
    return null;
  }
}

export async function argusTest(options: { dsn: string | undefined; json: boolean }): Promise<void> {
  const raw = options.dsn ?? env("ARGUS_DSN") ?? env("SENTRY_DSN");
  if (!raw) throw new Error("Pass --dsn <dsn> or set ARGUS_DSN. Copy it from the source in Argus.");
  const dsn = parseDsn(raw);
  if (!dsn) throw new Error("That isn't a DSN. It looks like https://<key>@argus-in.naijacloud.com/<number>.");

  const id = randomBytes(16).toString("hex");
  const sdk = { name: "naijacloud.cli", version: CLIENT_VERSION };
  const event = {
    event_id: id,
    timestamp: Date.now() / 1000,
    platform: "other",
    level: "info",
    message: `Argus test event from ${programName()}`,
    environment: env("ARGUS_ENVIRONMENT") ?? "production",
    tags: { argus_test: "true" },
    sdk,
  };
  const envelope =
    `${JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn: raw, sdk })}\n` +
    `${JSON.stringify({ type: "event" })}\n${JSON.stringify(event)}\n`;

  let res: Response;
  try {
    res = await fetch(`${dsn.origin}/api/${dsn.project}/envelope/`, {
      method: "POST",
      body: envelope,
      headers: {
        "content-type": "application/x-sentry-envelope",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_client=naijacloud-cli/${CLIENT_VERSION}, sentry_key=${dsn.key}`,
      },
    });
  } catch (error) {
    throw new Error(`Couldn't reach ${dsn.origin}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!res.ok) throw new Error(`Argus didn't accept the test event (HTTP ${res.status}). Check the DSN.`);
  if (options.json) {
    printJson({ sent: true, eventId: id });
    return;
  }
  process.stdout.write(`✓ Sent. Look for event ${id} in Argus under Errors.\n`);
}
