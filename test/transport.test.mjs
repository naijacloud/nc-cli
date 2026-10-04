import { test } from "node:test";
import assert from "node:assert/strict";

async function failWith(fetchImpl) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const { execute } = await import("../build/api/index.js");
    await execute("query Q { getMe { id } }", {}, "token");
    assert.fail("expected execute to throw");
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("a query the API no longer accepts asks the user to update, not 'HTTP 400'", async () => {
  const error = await failWith(async () =>
    Response.json(
      { errors: [{ message: 'Cannot query field "me"', extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] },
      { status: 400 },
    ),
  );
  assert.match(error.message, /no longer matches the NaijaCloud API/);
  assert.match(error.message, /npm install -g @naijacloud\/cli@latest/);
  assert.doesNotMatch(error.message, /HTTP 400/);
});

test("a timeout is reported in plain words", async () => {
  const error = await failWith(async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  assert.match(error.message, /did not answer within \d+s/);
  assert.doesNotMatch(error.message, /aborted/);
});

test("no network is reported in plain words", async () => {
  const error = await failWith(async () => {
    throw new TypeError("fetch failed");
  });
  assert.match(error.message, /Check your internet connection/);
  assert.doesNotMatch(error.message, /fetch failed/);
});
