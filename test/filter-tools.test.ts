import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { filterVisibleTools } from "../src/filter-tools";
import { baseConfig } from "./helpers";

type Tool = { name: string; description?: string; inputSchema: unknown };

const TOOLS: Tool[] = [
  { name: "db__query", inputSchema: {} },
  { name: "db__execute", inputSchema: {} },
  { name: "fs__read", inputSchema: {} },
];

// Batch-evaluations stub: any POST gets `handler(body)`. Returns the singular
// eval URL as `url` so we also exercise the evaluation→evaluations derivation.
function startStub(
  handler: (body: any) => { status: number; body: unknown }
): Promise<{ url: string; server: Server; calls: any[] }> {
  const calls: any[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push(raw ? JSON.parse(raw) : {});
      const { status, body } = handler(raw ? JSON.parse(raw) : {});
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}/access/v1/evaluation`, server, calls });
    });
  });
}

test("keeps only tools whose decision is true", async (t) => {
  const stub = await startStub(() => ({
    status: 200,
    body: { evaluations: [{ decision: true }, { decision: false }, { decision: true }] },
  }));
  t.after(() => stub.server.close());
  const config = baseConfig({ cloudUrl: stub.url, apiKey: "vgt_test" });
  const out = await filterVisibleTools(config, "agent:test", TOOLS);
  assert.deepEqual(out.map((x) => x.name), ["db__query", "fs__read"]);
  // one boxcarred batch call, subject+action as defaults, one eval per tool
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0].subject.id, "agent:test");
  assert.equal(stub.calls[0].action.name, "invoke");
  assert.equal(stub.calls[0].evaluations.length, 3);
  assert.equal(stub.calls[0].evaluations[0].resource.name, "db__query");
  assert.equal(stub.calls[0].evaluations[0].resource.type, "mcp_tool");
});

test("fails OPEN on authz error (default) → unfiltered", async (t) => {
  const stub = await startStub(() => ({ status: 500, body: { error: "boom" } }));
  t.after(() => stub.server.close());
  const config = baseConfig({ cloudUrl: stub.url });
  const out = await filterVisibleTools(config, "agent:test", TOOLS);
  assert.deepEqual(out.map((x) => x.name), TOOLS.map((x) => x.name));
});

test("fails CLOSED on authz error when configured → empty", async (t) => {
  const stub = await startStub(() => ({ status: 500, body: {} }));
  t.after(() => stub.server.close());
  const config = baseConfig({ cloudUrl: stub.url, filterToolsListFailClosed: true });
  const out = await filterVisibleTools(config, "agent:test", TOOLS);
  assert.deepEqual(out, []);
});

test("decision/tool length mismatch fails open (never mis-maps)", async (t) => {
  const stub = await startStub(() => ({ status: 200, body: { evaluations: [{ decision: true }] } }));
  t.after(() => stub.server.close());
  const config = baseConfig({ cloudUrl: stub.url });
  const out = await filterVisibleTools(config, "agent:test", TOOLS);
  assert.deepEqual(out.map((x) => x.name), TOOLS.map((x) => x.name));
});

test("empty tool list short-circuits — no authz call", async (t) => {
  const stub = await startStub(() => ({ status: 500, body: {} }));
  t.after(() => stub.server.close());
  const config = baseConfig({ cloudUrl: stub.url });
  const out = await filterVisibleTools(config, "agent:test", []);
  assert.deepEqual(out, []);
  assert.equal(stub.calls.length, 0);
});
