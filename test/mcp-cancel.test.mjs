// delete_deployment (the MCP tool that cancels) must not report a no-op as a
// success. The API answers a cancel of a RUNNING deployment with the record
// unchanged, and the tool used to return { cancelled: true } next to it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function callWithDeploymentIn(status) {
  const sent = [];
  const realFetch = globalThis.fetch;
  process.env.HOSTING_API_TOKEN = "test-token";
  globalThis.fetch = async (_url, init) => {
    const { query } = JSON.parse(init.body);
    sent.push(query);
    const deployment = { id: "d1", serviceId: "s1", status, service: { id: "s1", name: "web", url: null } };
    if (/cancelDeployment/.test(query)) {
      return Response.json({ data: { cancelDeployment: { ...deployment, status: "CANCELLED" } } });
    }
    return Response.json({ data: { getDeployment: deployment } });
  };
  try {
    const { createServer } = await import("../build/mcp/server.js");
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverSide);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(clientSide);
    const result = await client.callTool({
      name: "delete_deployment",
      arguments: { deploymentId: "d1", confirm: true },
    });
    await client.close();
    return { result, sent };
  } finally {
    globalThis.fetch = realFetch;
  }
}

test("cancelling a finished deployment is refused, and nothing is sent", async () => {
  const { result, sent } = await callWithDeploymentIn("RUNNING");
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /is RUNNING, so there is nothing to cancel/);
  assert.ok(!sent.some((query) => /cancelDeployment/.test(query)), "cancelDeployment was sent");
});

test("cancelling an in-flight deployment cancels it", async () => {
  const { result, sent } = await callWithDeploymentIn("BUILDING");
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).cancelled, true);
  assert.ok(sent.some((query) => /cancelDeployment/.test(query)));
});
