import { test } from "node:test";
import assert from "node:assert/strict";

test("authedList follows nextCursor, asking for the maximum page size first", async () => {
  const realFetch = globalThis.fetch;
  process.env.HOSTING_API_TOKEN = "test-token";
  const asked = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    asked.push(Object.fromEntries(url.searchParams));
    const cursor = url.searchParams.get("cursor");
    const page = cursor ? Number(cursor) : 1;
    return Response.json({ data: [page * 10 + 1, page * 10 + 2], nextCursor: page < 3 ? String(page + 1) : null });
  };
  try {
    const { authedList, MAX_PAGE_SIZE } = await import("../build/api/index.js");
    const all = await authedList("/things");
    assert.deepEqual(all, [11, 12, 21, 22, 31, 32]);
    assert.deepEqual(asked, [{ limit: String(MAX_PAGE_SIZE) }, { cursor: "2" }, { cursor: "3" }]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
