// `naijacloud requests`: a web service's recent requests over /v1 (TGL-3178).

import { test } from "node:test";
import assert from "node:assert/strict";

import { fail, run } from "./rest-stub.mjs";

const { requests, parseRequestFilters } = await import("../build/commands/requests.js");

const API = "11111111-1111-4111-8111-111111111111";
const row = (over = {}) => ({
  at: "2026-11-28T01:14:42.433Z",
  method: "POST",
  path: "/api/v1/webhooks/flutterwave",
  route: "/api/v1/webhooks/flutterwave",
  status: 200,
  durationMs: 4.9,
  bytes: 64,
  host: "neo-store-api.naijacloud.app",
  country: "NG",
  deploySha: null,
  ...over,
});

test("asks for the service's requests with the filters it was given", async () => {
  const r = await run(
    [["GET", new RegExp(`^/services/${API}/requests$`), { available: true, data: [row(), row({ method: "GET", status: 404 })] }]],
    () =>
      requests({
        service: API,
        path: "/api/v1/webhooks",
        method: "post",
        status: "4xx",
        since: "7d",
        limit: 20,
        json: false,
      }),
  );
  assert.equal(r.error, undefined);
  assert.deepEqual(r.sent.at(-1).query, {
    range: "LAST_7D",
    pathPrefix: "/api/v1/webhooks",
    method: "POST",
    status: "CLIENT_ERROR",
    limit: "20",
  });
  assert.match(r.out, /POST\s+200\s+5\s+\/api\/v1\/webhooks\/flutterwave/);
  assert.match(r.out, /GET\s+404/);
});

test("prints JSON as the API sent it with --json", async () => {
  const r = await run(
    [["GET", /\/requests$/, { available: true, data: [row()] }]],
    () => requests({ service: API, json: true }),
  );
  assert.equal(JSON.parse(r.out).data[0].status, 200);
});

test("says so when nothing matches, or history is unavailable", async () => {
  const empty = await run([["GET", /\/requests$/, { available: true, data: [] }]], () =>
    requests({ service: API, json: false }),
  );
  assert.match(empty.err, /No requests match/);
  const off = await run([["GET", /\/requests$/, { available: false, data: [] }]], () =>
    requests({ service: API, json: false }),
  );
  assert.match(off.err, /isn't available/);
});

test("refuses filters the API would refuse, before calling it", () => {
  assert.throws(() => parseRequestFilters({ since: "2w" }), /--since/);
  assert.throws(() => parseRequestFilters({ status: "teapot" }), /--status/);
  assert.throws(() => parseRequestFilters({ method: "TRACE" }), /--method/);
  assert.throws(() => parseRequestFilters({ path: "api/v1" }), /start with \//);
  assert.throws(() => parseRequestFilters({ limit: 500 }), /--limit/);
});

test("passes an API error through", async () => {
  const r = await run([["GET", /\/requests$/, fail(404, "NOT_FOUND", "service x does not serve HTTP requests")]], () =>
    requests({ service: API, json: false }),
  );
  assert.match(String(r.error?.message), /does not serve HTTP requests/);
});
