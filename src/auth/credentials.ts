/**
 * Where the access token lives.
 *
 * Credentials go in ~/.naijacloud/config.json with mode 0600, inside a 0700
 * directory. The only thing persisted is the token NaijaCloud's `login`
 * mutation returns, plus a little non-sensitive identity so `whoami` need not
 * hit the network. The password is never written to disk.
 *
 * This module is deliberately free of commands and of any API import: the
 * transport reads tokens from here, so a dependency in the other direction
 * would be a cycle.
 */

import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

export const CONFIG_DIR = join(homedir(), ".naijacloud");
export const CONFIG_FILE = join(CONFIG_DIR, "config.json");

/**
 * This machine's sign-in device id, sent as the `nc.device` cookie on a
 * password login (TGL-1171). Its own file, not a key in config.json, because
 * `logout` deletes config.json and the id must outlive that: the API emails
 * "New sign-in to your account" for any device it has not seen, so a fresh id
 * on every login would mail the owner every time.
 */
export const DEVICE_FILE = join(CONFIG_DIR, "device");

/** Env var that overrides the stored token (CI, or a second account). */
export const TOKEN_ENV_VAR = "HOSTING_API_TOKEN";

export interface StoredCredentials {
  /** NaijaCloud access token (JWT) sent as `Authorization: Bearer <token>`. */
  accessToken: string;
  /** Cached identity so `whoami` need not hit the network. Not authoritative. */
  user?: { id: string; email: string; name: string | null };
  /**
   * API base URL this token was issued against. The token is only sent to this
   * origin (TGL-1174); a file without it belongs to the default API.
   */
  apiBaseUrl?: string;
  savedAt?: string;
}

export type TokenSource = "env" | "file";

export interface ResolvedToken {
  token: string;
  source: TokenSource;
  /** For a stored token, the API base URL it was issued against. */
  issuedFor?: string;
}

/* -------------------------------------------------------------------------- */
/* Credential file read / write                                               */
/* -------------------------------------------------------------------------- */

export function readStoredCredentials(): StoredCredentials | null {
  let raw: string;
  try {
    raw = readFileSync(CONFIG_FILE, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as StoredCredentials).accessToken === "string" &&
      (parsed as StoredCredentials).accessToken.length > 0
    ) {
      return parsed as StoredCredentials;
    }
  } catch {
    // fall through
  }
  throw new Error(
    `Credential file ${CONFIG_FILE} is malformed. Run 'naijacloud logout' then 'naijacloud login' to recreate it.`,
  );
}

/** Writes credentials with owner-only permissions (dir 0700, file 0600). */
export function writeStoredCredentials(credentials: StoredCredentials): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // `mode` on writeFileSync is masked by the process umask, so chmod explicitly
  // afterwards to guarantee 0600 even when the file already existed.
  writeFileSync(CONFIG_FILE, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(CONFIG_FILE, 0o600);
}

/** Deletes the credential file. Returns false if there was nothing to delete. */
export function deleteStoredCredentials(): boolean {
  try {
    readFileSync(CONFIG_FILE);
  } catch {
    return false;
  }
  rmSync(CONFIG_FILE, { force: true });
  return true;
}

/**
 * Token resolution order: HOSTING_API_TOKEN, then ~/.naijacloud/config.json.
 * Returns null when neither is present — callers turn that into the
 * "Not logged in" message rather than letting a 401 escape.
 */
export function resolveToken(): ResolvedToken | null {
  const fromEnv = process.env[TOKEN_ENV_VAR]?.trim();
  if (fromEnv) return { token: fromEnv, source: "env" };

  const stored = readStoredCredentials();
  if (stored) {
    const resolved: ResolvedToken = { token: stored.accessToken, source: "file" };
    if (stored.apiBaseUrl) resolved.issuedFor = stored.apiBaseUrl;
    return resolved;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Device id                                                                  */
/* -------------------------------------------------------------------------- */

/** What the API accepts as a device id: an opaque token, safe in a cookie. */
const DEVICE_ID = /^[A-Za-z0-9._-]{8,128}$/;

function writeDeviceId(id: string): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(DEVICE_FILE, `${id}\n`, { mode: 0o600 });
  chmodSync(DEVICE_FILE, 0o600);
}

/**
 * This machine's device id, created on first use (32 random bytes, hex) and
 * kept in ~/.naijacloud/device with mode 0600. A file that cannot be written
 * still yields an id for this run, so a read-only home never blocks a login.
 */
export function deviceId(): string {
  try {
    const existing = readFileSync(DEVICE_FILE, "utf8").trim();
    if (DEVICE_ID.test(existing)) return existing;
  } catch {
    // missing: create below
  }
  const id = randomBytes(32).toString("hex");
  try {
    writeDeviceId(id);
  } catch {
    // best-effort; see above
  }
  return id;
}

/**
 * Adopts the id the API set in its `nc.device` cookie, when it differs from
 * ours. Today the API echoes back what it was sent, so this is a no-op; it
 * keeps the CLI right if the API ever starts issuing its own ids.
 */
export function rememberDeviceId(id: string): void {
  if (!DEVICE_ID.test(id)) return;
  try {
    if (readFileSync(DEVICE_FILE, "utf8").trim() === id) return;
  } catch {
    // fall through and write
  }
  try {
    writeDeviceId(id);
  } catch {
    // best-effort
  }
}
