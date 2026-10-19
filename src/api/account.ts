/**
 * The signed-in account: identity, and the password exchange that issues a token.
 */

import { NaijaCloudError, NotLoggedInError, authed, execute } from "./transport.js";
import type { User } from "./types.js";


/** `GET /v1/me` — also doubles as the token-validation endpoint used by login/whoami. */
export async function getCurrentUser(token?: string): Promise<User> {
  if (token) return await execute<User>("GET", "/me", token);
  return await authed<User>("GET", "/me");
}

/**
 * A sign-in that is waiting for its two-factor code: not a session, a
 * short-lived token to trade for one with {@link verifyTwoFactorSignIn}.
 */
export interface TwoFactorChallenge {
  pendingToken: string;
  expiresAt: string;
}

/**
 * The `login` answer: a session, or — for an account with two-factor on — a
 * `twoFactor` challenge with no token and no user.
 */
export interface LoginResult {
  accessToken: string | null;
  user: User | null;
  twoFactor: TwoFactorChallenge | null;
}

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<LoginResult> {
  try {
    // The device id is what lets the API recognise this machine and skip the
    // "New sign-in" email after the first login from it (TGL-1171).
    const result = await execute<LoginResult>("POST", "/auth/login", undefined, {
      body: { email, password },
      device: true,
    });
    return { ...result, twoFactor: result.twoFactor ?? null };
  } catch (error) {
    // A rejected password is a credentials problem, not a "log in again" loop.
    if (error instanceof NotLoggedInError) {
      throw new NaijaCloudError("Login failed: incorrect email or password.", {
        code: "UNAUTHENTICATED",
        statusCode: 401,
      });
    }
    throw error;
  }
}

/**
 * Finish a two-factor sign-in: the pending token from `login` plus a 6-digit
 * authenticator code or a one-time recovery code. Each code works once; five
 * wrong ones lock the account's code check for 15 minutes.
 */
export async function verifyTwoFactorSignIn(
  pendingToken: string,
  code: string,
): Promise<{ accessToken: string; user: User }> {
  try {
    const { accessToken, user } = await execute<{
      accessToken: string | null;
      user: User | null;
    }>("POST", "/auth/two-factor", undefined, { body: { pendingToken, code }, device: true });
    if (!accessToken || !user) {
      throw new NaijaCloudError("Two-factor sign-in did not return a session.");
    }
    return { accessToken, user };
  } catch (error) {
    // The pending token is the only credential here, so a 401 means it timed
    // out (ten minutes) or two-factor was reset meanwhile — start again.
    if (error instanceof NotLoggedInError) {
      throw new NaijaCloudError(
        "Your sign-in timed out. Run login again to start over.",
        { code: "UNAUTHENTICATED", statusCode: 401 },
      );
    }
    throw error;
  }
}
