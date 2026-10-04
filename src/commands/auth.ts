/**
 * `naijacloud login` / `logout` / `whoami`.
 *
 * The credential file itself is owned by auth/credentials.ts; this module is
 * the user-facing half — prompting, validating against the API before anything
 * is written, and reporting where the token in play came from.
 */

import process from "node:process";

import { NotLoggedInError, apiBaseUrl, getCurrentUser, loginWithPassword } from "../api/index.js";
import type { User } from "../api/index.js";
import {
  CONFIG_FILE,
  TOKEN_ENV_VAR,
  deleteStoredCredentials,
  resolveToken,
  writeStoredCredentials,
} from "../auth/credentials.js";
import { programName } from "../program-name.js";
import { promptLine, requireTty, write } from "../terminal.js";

/* -------------------------------------------------------------------------- */
/* Commands                                                                   */
/* -------------------------------------------------------------------------- */

export interface LoginOptions {
  email?: string;
  password?: string;
  /** Skip the password flow and store a token you already have. */
  token?: string;
}

/**
 * Authenticates and stores the resulting access token.
 *
 * NaijaCloud's control plane has no personal-access-token concept: the
 * documented way in is the `login(email, password)` mutation, which returns a
 * bearer token. So this prompts for email + password by default, and accepts
 * `--token` for CI where a token has already been obtained.
 */
export async function login(options: LoginOptions = {}): Promise<void> {
  const base = apiBaseUrl();

  let accessToken: string;

  if (options.token) {
    accessToken = options.token.trim();
    write(`Validating token against ${base} ...\n`);
  } else {
    if (options.email === undefined || options.password === undefined) {
      requireTty("Interactive login", [
        `${programName()} login --email you@example.com --password '<password>'`,
        `${programName()} login --token '<access-token>'`,
      ]);
    }

    const email = options.email ?? (await promptLine("NaijaCloud email: "));
    const password =
      options.password ?? (await promptLine("Password (hidden): ", { hidden: true }));

    if (!email.trim()) throw new Error("Email is required.");
    if (!password) throw new Error("Password is required.");

    write(`Signing in to ${base} ...\n`);
    const payload = await loginWithPassword(email.trim(), password);
    accessToken = payload.accessToken;
  }

  // Validate immediately against `me` — nothing is written if this fails.
  let user: User;
  try {
    user = await getCurrentUser(accessToken);
  } catch (error) {
    // Only an authentication failure says anything about the token; a network
    // or server error must not be reported as "your token was rejected".
    if (options.token && error instanceof NotLoggedInError) {
      throw new Error(
        `The token passed to --token was rejected by NaijaCloud (${error.message}). Nothing was saved.`,
      );
    }
    throw error;
  }

  writeStoredCredentials({
    accessToken,
    user: { id: user.id, email: user.email, name: displayName(user) },
    apiBaseUrl: base,
    savedAt: new Date().toISOString(),
  });

  process.stdout.write(`Logged in as ${user.email}\n`);
  write(`Token saved to ${CONFIG_FILE} (mode 0600).\n`);
}

export function logout(): void {
  const existed = deleteStoredCredentials();
  if (existed) {
    process.stdout.write(`Logged out. Removed ${CONFIG_FILE}\n`);
  } else {
    process.stdout.write("Not logged in — nothing to remove.\n");
  }

  if (process.env[TOKEN_ENV_VAR]) {
    write(
      `Note: ${TOKEN_ENV_VAR} is still set in this environment and will keep ` +
        "taking precedence over the credential file.\n",
    );
  }
}

export async function whoami(): Promise<void> {
  const resolved = resolveToken();
  if (!resolved) {
    // The CLI's own `whoami`, so it can name the invoked command. The
    // equivalent in src/api/transport.ts stays canonical: the MCP server shares
    // it, and there is no invoked name behind a tool call.
    process.stdout.write(`Not logged in. Run '${programName()} login' first.\n`);
    process.exitCode = 1;
    return;
  }

  const user = await getCurrentUser(resolved.token);
  const origin = resolved.source === "env" ? `${TOKEN_ENV_VAR} env var` : CONFIG_FILE;

  const name = displayName(user);
  process.stdout.write(
    [
      `${user.email}${name ? ` (${name})` : ""}`,
      `  user id:  ${user.id}`,
      `  status:   ${user.status}`,
      `  api:      ${apiBaseUrl()}`,
      `  token:    from ${origin}`,
      "",
    ].join("\n"),
  );
}

function displayName(user: User): string | null {
  if (user.name) return user.name;
  const parts = [user.firstName, user.lastName].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : null;
}
