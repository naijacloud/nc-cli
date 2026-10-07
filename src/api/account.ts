/**
 * The signed-in account: identity, and the password exchange that issues a token.
 */

import { NaijaCloudError, NotLoggedInError, authed, execute } from "./transport.js";
import type { User } from "./types.js";


/** `me` — also doubles as the token-validation endpoint used by login/whoami. */
export async function getCurrentUser(token?: string): Promise<User> {
  const query = `
    query CurrentUser {
      getMe { id email name firstName lastName status createdAt }
    }
  `;
  if (token) {
    const data = await execute<{ getMe: User }>(query, {}, token);
    return data.getMe;
  }
  const data = await authed<{ getMe: User }>(query);
  return data.getMe;
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
  const query = `
    mutation Login($input: LoginInput!) {
      login(LoginInput: $input) {
        accessToken
        user { id email name firstName lastName status createdAt }
        twoFactor { pendingToken expiresAt }
      }
    }
  `;
  try {
    const data = await execute<{ login: LoginResult }>(query, {
      input: { email, password },
    });
    return { ...data.login, twoFactor: data.login.twoFactor ?? null };
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
  const query = `
    mutation VerifyTwoFactorSignIn($input: VerifyTwoFactorSignInInput!) {
      verifyTwoFactorSignIn(VerifyTwoFactorSignInInput: $input) {
        accessToken
        user { id email name firstName lastName status createdAt }
      }
    }
  `;
  try {
    const data = await execute<{
      verifyTwoFactorSignIn: { accessToken: string | null; user: User | null };
    }>(query, { input: { pendingToken, code } });
    const { accessToken, user } = data.verifyTwoFactorSignIn;
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
