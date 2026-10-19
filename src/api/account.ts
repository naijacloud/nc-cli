/**
 * The signed-in account: identity, and the password exchange that issues a token.
 */

import { NaijaCloudError, NotLoggedInError, authed, execute } from "./transport.js";
import type { User } from "./types.js";

/** `GET /v1/me` and the `user` of a session. */
interface V1Me {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  emailVerifiedAt: string | null;
  createdAt: string;
}

/**
 * `/v1` reports whether the email is verified rather than an account status;
 * an unverified address is what blocks creating apps, so that is what shows.
 */
function toUser(me: V1Me): User {
  const name = [me.firstName, me.lastName].filter(Boolean).join(" ").trim();
  return {
    id: me.id,
    email: me.email,
    name: name || null,
    firstName: me.firstName,
    lastName: me.lastName,
    status: me.emailVerifiedAt ? "ACTIVE" : "EMAIL_NOT_VERIFIED",
    createdAt: me.createdAt,
  };
}


/** `GET /v1/me` — also doubles as the token-validation endpoint used by login/whoami. */
export async function getCurrentUser(token?: string): Promise<User> {
  if (token) return toUser(await execute<V1Me>("GET", "/me", token));
  return toUser(await authed<V1Me>("GET", "/me"));
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
    const result = await execute<{
      accessToken: string | null;
      user: V1Me | null;
      twoFactor: TwoFactorChallenge | null;
    }>("POST", "/auth/login", undefined, { body: { email, password }, device: true });
    return {
      accessToken: result.accessToken,
      user: result.user ? toUser(result.user) : null,
      twoFactor: result.twoFactor ?? null,
    };
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
    const session = await execute<{
      accessToken: string | null;
      user: V1Me | null;
    }>("POST", "/auth/two-factor", undefined, { body: { pendingToken, code }, device: true });
    const accessToken = session.accessToken;
    const user = session.user ? toUser(session.user) : null;
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
