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

test("an HTML 403 is a blocked request, not rejected credentials", async () => {
  const error = await failWith(async () =>
    new Response("<html>Access denied</html>", { status: 403, headers: { "content-type": "text/html" } }),
  );
  assert.match(error.message, /blocked before it reached the NaijaCloud API/);
  assert.doesNotMatch(error.message, /rejected the stored credentials/);
});

test("a 401 whose GraphQL body says UNAUTHENTICATED is a login problem", async () => {
  const error = await failWith(async () =>
    Response.json({ errors: [{ message: "no", extensions: { code: "UNAUTHENTICATED" } }] }, { status: 401 }),
  );
  assert.equal(error.name, "NotLoggedInError");
});

test("429 says to wait, using Retry-After", async () => {
  const error = await failWith(async () =>
    new Response("slow down", { status: 429, statusText: "Too Many Requests", headers: { "retry-after": "30" } }),
  );
  assert.match(error.message, /Wait 30 seconds and try again/);
});

test("a connection cut mid-answer says the connection dropped", async () => {
  const error = await failWith(async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":{"get'));
        controller.error(new TypeError("terminated"));
      },
    });
    return new Response(body, { status: 200 });
  });
  assert.match(error.message, /connection dropped/);
  assert.doesNotMatch(error.message, /non-JSON/);
});

test("plain http to another host is refused before anything is sent", async () => {
  const real = process.env.HOSTING_API_BASE_URL;
  process.env.HOSTING_API_BASE_URL = "http://api.example.com";
  let called = false;
  try {
    const error = await failWith(async () => {
      called = true;
      return Response.json({ data: {} });
    });
    assert.match(error.message, /Refusing to send credentials/);
    assert.equal(called, false);
  } finally {
    if (real === undefined) delete process.env.HOSTING_API_BASE_URL;
    else process.env.HOSTING_API_BASE_URL = real;
  }
});

test("http to localhost is allowed, and a malformed base URL is called invalid", async () => {
  const real = process.env.HOSTING_API_BASE_URL;
  try {
    process.env.HOSTING_API_BASE_URL = "http://127.0.0.1:4003";
    const { execute } = await import("../build/api/index.js");
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => Response.json({ data: { getMe: { id: "u" } } });
    try {
      assert.deepEqual(await execute("query Q { getMe { id } }", {}, "t"), { getMe: { id: "u" } });
    } finally {
      globalThis.fetch = realFetch;
    }
    process.env.HOSTING_API_BASE_URL = "notaurl";
    const error = await failWith(async () => Response.json({ data: {} }));
    assert.match(error.message, /not a valid URL/);
  } finally {
    if (real === undefined) delete process.env.HOSTING_API_BASE_URL;
    else process.env.HOSTING_API_BASE_URL = real;
  }
});
