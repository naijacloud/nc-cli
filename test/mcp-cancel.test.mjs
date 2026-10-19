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
  globalThis.fetch = async (input, init = {}) => {
    const path = new URL(String(input)).pathname;
    sent.push(`${init.method ?? "GET"} ${path}`);
    const deploy = { id: "d1", serviceId: "s1", status, createdAt: "2026-01-01T00:00:00.000Z" };
    if (path === "/v1/deploys/d1/cancel") return Response.json({ ...deploy, status: "CANCELLED" });
    if (path === "/v1/deploys/d1") return Response.json(deploy);
    if (path === "/v1/services/s1") {
      return Response.json({ id: "s1", environmentId: "e1", name: "web", type: "WEB", status: "ACTIVE", url: null, source: {}, build: {} });
    }
    return new Response("not stubbed", { status: 404 });
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
  assert.ok(!sent.includes("POST /v1/deploys/d1/cancel"), "the cancel was sent");
});

test("cancelling an in-flight deployment cancels it", async () => {
  const { result, sent } = await callWithDeploymentIn("BUILDING");
  assert.notEqual(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).cancelled, true);
  assert.ok(sent.includes("POST /v1/deploys/d1/cancel"));
});
