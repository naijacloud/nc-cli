import { test } from "node:test";
import assert from "node:assert/strict";

test("authedAllPages reads every page at the maximum size", async () => {
  const realFetch = globalThis.fetch;
  process.env.HOSTING_API_TOKEN = "test-token";
  const asked = [];
  globalThis.fetch = async (_url, init) => {
    const { variables } = JSON.parse(init.body);
    asked.push(variables.page);
    const page = variables.page.page;
    return Response.json({
      data: { list: { items: [page * 10 + 1, page * 10 + 2], pageInfo: { hasNextPage: page < 3 } } },
    });
  };
  try {
    const { authedAllPages, MAX_PAGE_SIZE } = await import("../build/api/index.js");
    const all = await authedAllPages("query Q($page: OffsetPaginationArgs) { x }", {}, (d) => d.list);
    assert.deepEqual(all, [11, 12, 21, 22, 31, 32]);
    assert.deepEqual(asked, [1, 2, 3].map((page) => ({ page, limit: MAX_PAGE_SIZE })));
  } finally {
    globalThis.fetch = realFetch;
  }
});
