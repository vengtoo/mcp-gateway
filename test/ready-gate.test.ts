import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as NodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createConfiguredServer, type GatewayContext, type DownstreamServer } from "../src/gateway";
import { AuditLog } from "../src/audit";
import { baseConfig } from "./helpers";

/** Authz stub that allows everything. */
function startAuthz(): Promise<{ url: string; server: NodeHttpServer }> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: true, context: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server });
    });
  });
}

const cleanup: Array<() => unknown> = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

beforeEach(() => {
  // Keep the gate deterministic and fast: fail closed after 150ms if not ready.
  process.env.VENGTOO_READY_TIMEOUT_MS = "150";
});

function text(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
}

interface TestGateway {
  client: Client;
  downstreamCalls: Array<{ name: string; arguments: unknown }>;
}

async function buildGateway(ready: Promise<void> | undefined, agentUrl?: string): Promise<TestGateway> {
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
    tools: [{ name: "query", description: "Run a query", inputSchema: { type: "object" } }],
  } as unknown as DownstreamServer;

  const ctx: GatewayContext = {
    config: baseConfig({ agentUrl }),
    downstreams: [fakeDownstream],
    toolIndex: new Map([["db__query", { downstream: fakeDownstream, originalName: "query" }]]),
    audit: new AuditLog(),
    blockedTools: new Set(),
    pendingTools: new Set(),
    ready,
  };

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createConfiguredServer(ctx);
  await server.connect(serverTransport);
  const client = new Client({ name: "test-caller", version: "1.0.0" }, { capabilities: {} });
  await client.connect(clientTransport);
  cleanup.push(() => client.close());

  return { client, downstreamCalls };
}

test("CallTool during a never-resolving initial restore is DENIED (fail-closed), not allowed", async () => {
  const authz = await startAuthz();
  cleanup.push(() => authz.server.close());

  // Simulate a hung startup sync: ready never resolves.
  const neverReady = new Promise<void>(() => { /* never */ });
  const gw = await buildGateway(neverReady, authz.url);

  const result = await gw.client.callTool({ name: "db__query", arguments: {} });
  assert.equal(result.isError, true, "call must be denied while still initializing");
  assert.match(text(result), /still initializing/);
  assert.equal(gw.downstreamCalls.length, 0, "downstream must NOT be reached during the startup window");
});

test("CallTool proceeds once the ready gate opens", async () => {
  const authz = await startAuthz();
  cleanup.push(() => authz.server.close());

  const gw = await buildGateway(Promise.resolve(), authz.url);
  const result = await gw.client.callTool({ name: "db__query", arguments: { sql: "SELECT 1" } });
  assert.equal(result.isError ?? false, false);
  assert.equal(text(result), "ok:query");
  assert.equal(gw.downstreamCalls.length, 1);
});

test("local mode (no apiKey → no ready gate) does NOT block", async () => {
  const authz = await startAuthz();
  cleanup.push(() => authz.server.close());

  // Local/standalone gateways have no cloud governance and pass `ready` as
  // undefined (or an already-resolved promise). The gate must be a no-op.
  const gw = await buildGateway(undefined, authz.url);
  const result = await gw.client.callTool({ name: "db__query", arguments: {} });
  assert.equal(result.isError ?? false, false, "local mode must not be held by the gate");
  assert.equal(text(result), "ok:query");
  assert.equal(gw.downstreamCalls.length, 1);
});
