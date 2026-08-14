import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConfiguredServer, type GatewayContext, type DownstreamServer } from "../src/gateway";
import { AuditLog } from "../src/audit";
import { baseConfig } from "./helpers";

/** Authz stub that allows everything except tools listed in `denied`. */
function startAuthz(denied: Set<string>): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { resource: { name: string } };
      const allowed = !denied.has(body.resource.name);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: allowed, context: allowed ? {} : { reason: "explicit deny" } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
    });
  });
}

interface TestGateway {
  client: Client;
  downstreamCalls: Array<{ name: string; arguments: unknown }>;
  ctx: GatewayContext;
}

async function buildGateway(opts: {
  denied?: Set<string>;
  blocked?: string[];
  pending?: string[];
}): Promise<TestGateway> {
  const authz = await startAuthz(opts.denied ?? new Set());
  cleanup.push(() => authz.server.close());

  const downstreamCalls: Array<{ name: string; arguments: unknown }> = [];
  const fakeDownstream = {
    name: "db",
    client: {
      callTool: async (req: { name: string; arguments: unknown }) => {
        downstreamCalls.push(req);
        return { content: [{ type: "text", text: `ok:${req.name}` }] };
      },
    },
    transport: { close: async () => undefined },
    tools: [
      { name: "query", description: "Run a query", inputSchema: { type: "object" } },
      { name: "drop", description: "Drop a table", inputSchema: { type: "object" } },
      { name: "drifted", description: "A drifted tool", inputSchema: { type: "object" } },
      { name: "unreviewed", description: "A new tool", inputSchema: { type: "object" } },
    ],
  } as unknown as DownstreamServer;

  const config = baseConfig({ agentUrl: authz.url });
  const ctx: GatewayContext = {
    config,
    downstreams: [fakeDownstream],
    toolIndex: new Map(
      fakeDownstream.tools.map((t) => [`db__${t.name}`, { downstream: fakeDownstream, originalName: t.name }])
    ),
    audit: new AuditLog(),
    blockedTools: new Set(opts.blocked ?? []),
    pendingTools: new Set(opts.pending ?? []),
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConfiguredServer(ctx);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-caller", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  cleanup.push(() => client.close());

  return { client, downstreamCalls, ctx };
}

const cleanup: Array<() => unknown> = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

test("allowed tool call reaches the downstream", async () => {
  const gw = await buildGateway({});
  const result = await gw.client.callTool({ name: "db__query", arguments: { sql: "SELECT 1" } });
  assert.equal(result.isError ?? false, false);
  assert.equal(text(result), "ok:query");
  assert.deepEqual(gw.downstreamCalls, [{ name: "query", arguments: { sql: "SELECT 1" } }]);
});

test("policy-denied tool never reaches the downstream", async () => {
  const gw = await buildGateway({ denied: new Set(["db__drop"]) });
  const result = await gw.client.callTool({ name: "db__drop", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /Access denied/);
  assert.match(text(result), /explicit deny/);
  assert.equal(gw.downstreamCalls.length, 0, "downstream must not be called on deny");
});

test("blocked (drifted) tool is denied without an authz round-trip", async () => {
  const gw = await buildGateway({ blocked: ["db__drifted"] });
  const result = await gw.client.callTool({ name: "db__drifted", arguments: {} });
  assert.equal(result.isError, true);
  // Reason-neutral message: the gateway can't tell drift from a manual
  // block, so it must not assert "schema drift".
  assert.match(text(result), /is blocked\. An admin must re-approve/);
  assert.equal(gw.downstreamCalls.length, 0);
});

test("pending-review tool is denied fail-closed", async () => {
  const gw = await buildGateway({ pending: ["db__unreviewed"] });
  const result = await gw.client.callTool({ name: "db__unreviewed", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /pending review/);
  assert.equal(gw.downstreamCalls.length, 0);
});

test("unknown tool returns an error without touching authz or downstream", async () => {
  const gw = await buildGateway({});
  const result = await gw.client.callTool({ name: "db__nope", arguments: {} });
  assert.equal(result.isError, true);
  assert.match(text(result), /Unknown tool/);
});

test("blocked and pending tools are filtered out of tools/list", async () => {
  const gw = await buildGateway({ blocked: ["db__drifted"], pending: ["db__unreviewed"] });
  const { tools } = await gw.client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["db__drop", "db__query"]);
});

test("a block added at runtime applies to an already-connected session", async () => {
  const gw = await buildGateway({});
  const before = await gw.client.callTool({ name: "db__query", arguments: {} });
  assert.equal(before.isError ?? false, false);

  gw.ctx.blockedTools.add("db__query"); // e.g. the cloud reports drift mid-session
  const afterBlock = await gw.client.callTool({ name: "db__query", arguments: {} });
  assert.equal(afterBlock.isError, true);
  assert.match(text(afterBlock), /blocked/);
});
