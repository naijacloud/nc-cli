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

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<{ accessToken: string; user: User }> {
  const query = `
    mutation Login($input: LoginInput!) {
      login(LoginInput: $input) {
        accessToken
        user { id email name firstName lastName status createdAt }
      }
    }
  `;
  try {
    const data = await execute<{ login: { accessToken: string; user: User } }>(
      query,
      { input: { email, password } },
    );
    return data.login;
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
