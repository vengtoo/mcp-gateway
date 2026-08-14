import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { authorize } from "../src/authorize";
import type { GatewayConfig } from "./helpers";
import { baseConfig } from "./helpers";

type Responder = (body: unknown) => { status: number; body: unknown };

/** One-shot authz stub: each request pops the next scripted response. */
function startStub(script: Responder[]): Promise<{ url: string; server: Server; calls: unknown[] }> {
  const calls: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      calls.push(body);
      const responder = script.shift();
      if (!responder) {
        res.writeHead(500);
        res.end("script exhausted");
        return;
      }
      const { status, body: resBody } = responder(body);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(resBody));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, server, calls });
    });
  });
}

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function withStub(script: Responder[]): Promise<{ config: GatewayConfig; calls: unknown[] }> {
  const stub = await startStub(script);
  servers.push(stub.server);
  return { config: baseConfig({ agentUrl: stub.url }), calls: stub.calls };
}

const allow = (): Responder => () => ({ status: 200, body: { decision: true, context: {} } });
const denyWith = (reason: string): Responder => () => ({
  status: 200,
  body: { decision: false, context: { reason } },
});

test("allow decision passes through", async () => {
  const { config, calls } = await withStub([allow()]);
  const result = await authorize(config, "agent:a", "db__query", { sql: "SELECT 1" });
  assert.equal(result.allowed, true);
  // Request shape: AuthZEN subject/resource/action with args as attributes.
  const sent = calls[0] as { resource: { name: string; attributes: { sql: string } }; action: { name: string } };
  assert.equal(sent.resource.name, "db__query");
  assert.equal(sent.resource.attributes.sql, "SELECT 1");
  assert.equal(sent.action.name, "invoke");
});

test("deny decision carries the policy reason", async () => {
  const { config } = await withStub([denyWith("explicit deny")]);
  const result = await authorize(config, "agent:a", "db__drop", {});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "explicit deny");
});

test("401 fails closed with an auth hint", async () => {
  const { config } = await withStub([() => ({ status: 401, body: {} })]);
  const result = await authorize(config, "agent:a", "t", {});
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /authentication failed/);
});

test("404 fails closed (no policy configured)", async () => {
  const { config } = await withStub([() => ({ status: 404, body: {} })]);
  const result = await authorize(config, "agent:a", "t", {});
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /no authorization policy/);
});

test("unreachable authz endpoint fails closed", async () => {
  const config = baseConfig({ agentUrl: "http://127.0.0.1:1" }); // nothing listens here
  const result = await authorize(config, "agent:a", "t", {});
  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /unreachable/);
});

test("5xx from agent fails over to the cloud endpoint", async () => {
  const agent = await startStub([() => ({ status: 500, body: { error: "boom" } })]);
  const cloud = await startStub([allow()]);
  servers.push(agent.server, cloud.server);
  const config = baseConfig({
    agentUrl: agent.url,
    cloudUrl: `${cloud.url}/access/v1/evaluation`,
  });
  const result = await authorize(config, "agent:a", "t", {});
  assert.equal(result.allowed, true, "second endpoint should have been consulted");
  assert.equal(cloud.calls.length, 1);
});

test("HITL: authorization_pending polls until approved", async () => {
  const pending = (): Responder => () => ({
    status: 200,
    body: {
      decision: false,
      context: {
        reason_code: "authorization_pending",
        approval_id: "apr_1",
        interval: 0.01, // poll every 10ms so the test is fast
        expires_in: 5,
      },
    },
  });
  const { config, calls } = await withStub([pending(), pending(), allow()]);
  const result = await authorize(config, "agent:a", "prod__deploy", {});
  assert.equal(result.allowed, true);
  assert.equal(calls.length, 3, "should have polled the same request until terminal");
});

test("HITL: denial by approver is terminal", async () => {
  const { config } = await withStub([
    () => ({
      status: 200,
      body: {
        decision: false,
        context: { reason_code: "authorization_pending", approval_id: "apr_2", interval: 0.01, expires_in: 5 },
      },
    }),
    () => ({
      status: 200,
      body: { decision: false, context: { reason_code: "access_denied" } },
    }),
  ]);
  const result = await authorize(config, "agent:a", "prod__deploy", {});
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "denied by approver");
});
