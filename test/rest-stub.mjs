// A stub of the `/v1` REST API for tests: routes match on method + path, and
// every request the CLI sends is recorded so a test can assert on it.

/** `{ data, nextCursor: null }`: one page of a `/v1` list. */
export const list = (data) => ({ data, nextCursor: null });

/** The `/v1` error envelope, with its HTTP status. */
export const fail = (status, code, message) => ({
  status,
  body: { error: { code, message, requestId: "req-test" } },
});

/**
 * Installs a fetch stub. `routes` is a list of `[method, pattern, answer]`:
 * `pattern` is a regex tested against the path after `/v1`, and `answer` is a
 * value (sent as JSON with status 200), a `{ status, body }` from {@link fail},
 * or a function `(request) => …` returning either. An unmatched request answers
 * a 404 with no envelope, which the CLI reports as an API mismatch.
 *
 * Returns `{ sent, restore }`; `sent` holds `{ method, path, query, body, headers }`.
 */
export function stubApi(routes) {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const path = url.pathname.replace(/^\/v1/, "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    const request = {
      method,
      path,
      query: Object.fromEntries(url.searchParams),
      body,
      headers: init.headers ?? {},
    };
    sent.push(request);
    for (const [routeMethod, pattern, answer] of routes) {
      if (routeMethod !== method || !pattern.test(path)) continue;
      const result = typeof answer === "function" ? await answer(request) : answer;
      if (result && typeof result === "object" && "status" in result && "body" in result) {
        return Response.json(result.body, { status: result.status, headers: result.headers ?? {} });
      }
      if (result === undefined) return new Response(null, { status: 204 });
      return Response.json(result);
    }
    return new Response(`Cannot ${method} ${url.pathname}`, { status: 404 });
  };
  return { sent, restore: () => (globalThis.fetch = realFetch) };
}

/** Runs `fn` against a stubbed API, capturing stdout, stderr and any error. */
export async function run(routes, fn) {
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  const out = [];
  const err = [];
  process.env.HOSTING_API_TOKEN ??= "test-token";
  const { sent, restore } = stubApi(routes);
  process.stdout.write = (chunk) => (out.push(String(chunk)), true);
  process.stderr.write = (chunk) => (err.push(String(chunk)), true);
  let error;
  try {
    await fn();
  } catch (caught) {
    error = caught;
  } finally {
    restore();
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  return { out: out.join(""), err: err.join(""), sent, error };
}

/** A `/v1` service with sensible defaults. */
export function v1Service(overrides = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env-1",
    name: "api",
    type: "WEB",
    status: "ACTIVE",
    url: "https://api.naijacloud.app",
    isStatic: false,
    source: { type: "GITHUB_APP", repoFullName: "acme/api", gitUrl: null, branch: "main", rootDir: null, image: null, imageCommand: null },
    build: { buildCommand: null, startCommand: null, runtimeVersion: null, staticOutputDir: null, staticSpa: null, monorepoStrategy: null, watchPaths: null },
    health: "HEALTHY",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** A `/v1` deploy with sensible defaults. */
export function v1Deploy(overrides = {}) {
  return {
    id: "dep1",
    serviceId: "11111111-1111-4111-8111-111111111111",
    status: "QUEUED",
    trigger: "MANUAL",
    branch: "main",
    commitSha: null,
    commitMessage: null,
    authorName: null,
    error: null,
    errorCode: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}
