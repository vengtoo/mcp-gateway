import { test, after } from "node:test";
import assert from "node:assert/strict";
import { startHttpServer, type HttpOptions } from "../src/http-server";
import type { GatewayContext } from "../src/gateway";
import { AuditLog } from "../src/audit";
import { baseConfig } from "./helpers";

function minimalCtx(): GatewayContext {
  const config = baseConfig({ agentUrl: "http://127.0.0.1:1" });
  return {
    config,
    downstreams: [],
    toolIndex: new Map(),
    audit: new AuditLog(),
    blockedTools: new Set(),
    pendingTools: new Set(),
  };
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers) {
    try { await close(); } catch { /* best effort */ }
  }
});

async function start(opts: Partial<HttpOptions>): Promise<string> {
  const full: HttpOptions = { port: 0, host: "127.0.0.1", path: "/mcp", ...opts };
  // port 0 → ephemeral; recover the bound port from the close fn's server?
  // startHttpServer doesn't expose it, so bind a fixed high port per test.
  const close = await startHttpServer(minimalCtx(), full);
  closers.push(close);
  return `http://127.0.0.1:${full.port}`;
}

let nextPort = 38200;
function port(): number { return nextPort++; }

test("refuses to bind a public interface without auth (fail closed)", async () => {
  // assertSafeToBind throws synchronously — wrap so it surfaces as a rejection.
  await assert.rejects(
    async () => startHttpServer(minimalCtx(), { port: port(), host: "0.0.0.0", path: "/mcp" }),
    /refusing to bind/
  );
});

test("binds a public interface when tokens are configured", async () => {
  const p = port();
  const base = await start({ port: p, host: "0.0.0.0", authTokens: ["tok"] });
  const res = await fetch(`http://127.0.0.1:${p}/healthz`);
  assert.equal(res.status, 200);
  void base;
});

test("healthz is open; MCP endpoint requires the bearer token", async () => {
  const p = port();
  await start({ port: p, authTokens: ["s3cret"] });

  const health = await fetch(`http://127.0.0.1:${p}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { status: string }).status, "ok");

  const noAuth = await fetch(`http://127.0.0.1:${p}/mcp`, { method: "POST", body: "{}" });
  assert.equal(noAuth.status, 401);

  const badToken = await fetch(`http://127.0.0.1:${p}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer wrong" },
    body: "{}",
  });
  assert.equal(badToken.status, 401);
});

test("authorized non-initialize request without a session is a 400", async () => {
  const p = port();
  await start({ port: p, authTokens: ["s3cret"] });
  const res = await fetch(`http://127.0.0.1:${p}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
  });
  assert.equal(res.status, 400);
});

test("unknown path is 404; unsupported method is 405", async () => {
  const p = port();
  await start({ port: p, authTokens: ["s3cret"] });
  assert.equal((await fetch(`http://127.0.0.1:${p}/other`)).status, 404);
  const res = await fetch(`http://127.0.0.1:${p}/mcp`, {
    method: "PUT",
    headers: { Authorization: "Bearer s3cret" },
  });
  assert.equal(res.status, 405);
});

test("oversized body is rejected with 413", async () => {
  const p = port();
  await start({ port: p, authTokens: ["s3cret"] });
  const big = "x".repeat(5 * 1024 * 1024); // > 4MB cap
  const res = await fetch(`http://127.0.0.1:${p}/mcp`, {
    method: "POST",
    headers: { Authorization: "Bearer s3cret", "Content-Type": "application/json" },
    body: JSON.stringify({ pad: big }),
  }).catch(() => undefined);
  // Server may cut the connection mid-upload (req.destroy) or answer 413.
  if (res) assert.equal(res.status, 413);
});
