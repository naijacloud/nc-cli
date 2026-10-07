/**
 * `naijacloud login` / `logout` / `whoami`.
 *
 * The credential file itself is owned by auth/credentials.ts; this module is
 * the user-facing half — prompting, validating against the API before anything
 * is written, and reporting where the token in play came from.
 */

import process from "node:process";

import {
  NaijaCloudError,
  NotLoggedInError,
  apiBaseUrl,
  getCurrentUser,
  loginWithPassword,
  verifyTwoFactorSignIn,
} from "../api/index.js";
import type { User } from "../api/index.js";
import {
  CONFIG_FILE,
  TOKEN_ENV_VAR,
  deleteStoredCredentials,
  resolveToken,
  writeStoredCredentials,
} from "../auth/credentials.js";
import { printJson } from "../output.js";
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
  /**
   * The two-factor code (or a recovery code), for a non-interactive login on
   * an account with two-factor on. Prompted for in a terminal otherwise.
   */
  code?: string;
}

/** Wrong codes the interactive prompt allows before giving up. */
const CODE_TRIES = 3;

/**
 * Authenticates and stores the resulting access token.
 *
 * Prompts for email + password by default, which the `login` mutation exchanges
 * for a short-lived session token. `--token` stores a credential already in
 * hand — in CI that is a workspace API key (`nc_live_…`, from Settings → API
 * keys), which the API accepts as a bearer token like a session.
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
    if (payload.twoFactor) {
      accessToken = await answerTwoFactor(payload.twoFactor.pendingToken, options.code);
    } else if (payload.accessToken) {
      accessToken = payload.accessToken;
    } else {
      throw new Error("Login did not return a session. Try again.");
    }
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

/**
 * The second step of a password login on an account with two-factor on.
 *
 * `--code` is used once, as given, for scripts. In a terminal the code is
 * prompted for, with a few tries for a mistyped code. API keys and `--token`
 * never reach this: they are not a sign-in, so two-factor does not apply.
 */
async function answerTwoFactor(pendingToken: string, given?: string): Promise<string> {
  if (given !== undefined) {
    const { accessToken } = await verifyTwoFactorSignIn(pendingToken, given.trim());
    return accessToken;
  }
  requireTty("This account uses two-factor authentication, so login", [
    `${programName()} login --email you@example.com --password '<password>' --code <6-digit code>`,
    `${programName()} login --token '<nc_live_ API key>'`,
  ]);
  write("This account uses two-factor authentication.\n");
  for (let attempt = 1; ; attempt++) {
    const code = (
      await promptLine("Authenticator code (or a recovery code): ")
    ).trim();
    if (!code) {
      if (attempt >= CODE_TRIES) throw new Error("A two-factor code is required.");
      continue;
    }
    try {
      const { accessToken } = await verifyTwoFactorSignIn(pendingToken, code);
      return accessToken;
    } catch (error) {
      // Only a wrong code is worth another try; a lockout or a timed-out
      // sign-in will not get better by typing again.
      const wrong =
        error instanceof NaijaCloudError &&
        error.code !== "UNAUTHENTICATED" &&
        /isn.t right/i.test(error.message);
      if (!wrong || attempt >= CODE_TRIES) throw error;
      write(`${error.message}\n`);
    }
  }
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

export async function whoami(options: { json?: boolean } = {}): Promise<void> {
  const resolved = resolveToken();
  if (!resolved) {
    if (options.json) {
      printJson({ loggedIn: false });
      process.exitCode = 1;
      return;
    }
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
  if (options.json) {
    printJson({
      loggedIn: true,
      id: user.id,
      email: user.email,
      name,
      status: user.status,
      apiBaseUrl: apiBaseUrl(),
      tokenSource: resolved.source,
    });
    return;
  }
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
