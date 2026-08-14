import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server as NodeHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer, resolveHttpOptions } from "../src/http-server";
import type { GatewayContext, DownstreamServer } from "../src/gateway";
import { AuditLog } from "../src/audit";
import { baseConfig } from "./helpers";

/** Authz stub that allows everything and records each request's subject id. */
function startAuthz(): Promise<{ url: string; server: NodeHttpServer; subjects: string[] }> {
  const subjects: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw) as { subject: { id: string } };
      subjects.push(body.subject.id);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: true, context: {} }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, subjects });
    });
  });
}

const cleanup: Array<() => unknown> = [];
after(async () => {
  for (const fn of cleanup.reverse()) {
    try { await fn(); } catch { /* best effort */ }
  }
});

let nextPort = 38400;

async function startIdentifiedGateway(): Promise<{ url: string; subjects: string[] }> {
  const authz = await startAuthz();
  cleanup.push(() => authz.server.close());

  const fakeDownstream = {
    name: "db",
    client: { callTool: async () => ({ content: [{ type: "text", text: "ok" }] }) },
    transport: { close: async () => undefined },
    tools: [{ name: "query", description: "q", inputSchema: { type: "object" } }],
  } as unknown as DownstreamServer;

  const config = baseConfig({ agentUrl: authz.url });
  const ctx: GatewayContext = {
    config,
    downstreams: [fakeDownstream],
    toolIndex: new Map([["db__query", { downstream: fakeDownstream, originalName: "query" }]]),
    audit: new AuditLog(),
    blockedTools: new Set(),
    pendingTools: new Set(),
  };

  const port = nextPort++;
  const close = await startHttpServer(ctx, {
    port,
    host: "127.0.0.1",
    path: "/mcp",
    callers: [
      { token: "tok-claude", subject: "agent:claude" },
      { token: "tok-cursor", subject: "agent:cursor" },
    ],
    authTokens: ["tok-anon"],
  });
  cleanup.push(close);
  return { url: `http://127.0.0.1:${port}/mcp`, subjects: authz.subjects };
}

async function connectWith(url: string, token: string): Promise<{ client: Client; transport: StreamableHTTPClientTransport }> {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "caller", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return { client, transport };
}

test("each caller token is authorized as its own subject", async () => {
  const gw = await startIdentifiedGateway();

  const claude = await connectWith(gw.url, "tok-claude");
  await claude.client.callTool({ name: "db__query", arguments: {} });

  const cursor = await connectWith(gw.url, "tok-cursor");
  await cursor.client.callTool({ name: "db__query", arguments: {} });

  // Anonymous legacy token falls back to the config's global subject.
  const anon = await connectWith(gw.url, "tok-anon");
  await anon.client.callTool({ name: "db__query", arguments: {} });

  assert.deepEqual(gw.subjects, ["agent:claude", "agent:cursor", "agent:test"]);
});

test("a second valid caller cannot attach to another caller's session", async () => {
  const gw = await startIdentifiedGateway();

  const claude = await connectWith(gw.url, "tok-claude");
  await claude.client.callTool({ name: "db__query", arguments: {} });
  const sessionId = claude.transport.sessionId;
  assert.ok(sessionId, "session id should be assigned after initialize");

  // tok-cursor is a VALID token — but presenting Claude's session id must not
  // let it run as agent:claude (or at all, on that session).
  const res = await fetch(gw.url, {
    method: "POST",
    headers: {
      Authorization: "Bearer tok-cursor",
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "db__query", arguments: {} },
    }),
  });
  assert.equal(res.status, 401, "cross-caller session reuse must be rejected");
  const claudeCalls = gw.subjects.filter((s) => s === "agent:claude").length;
  assert.equal(claudeCalls, 1, "no additional call must run as agent:claude");
});

test("VENGTOO_GATEWAY_HTTP_CALLERS env parsing", () => {
  process.env.VENGTOO_GATEWAY_HTTP_CALLERS = "tokA=agent:claude, malformed ,tokB=agent:cursor";
  try {
    const opts = resolveHttpOptions(baseConfig({ agentUrl: "http://127.0.0.1:1" }));
    assert.deepEqual(opts.callers, [
      { token: "tokA", subject: "agent:claude" },
      { token: "tokB", subject: "agent:cursor" },
    ]);
  } finally {
    delete process.env.VENGTOO_GATEWAY_HTTP_CALLERS;
  }
});
