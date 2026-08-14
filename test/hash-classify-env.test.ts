import { test } from "node:test";
import assert from "node:assert/strict";
import { computeToolsHash } from "../src/hash";
import { classifyTool } from "../src/classify";
import { extractFields, downstreamEnv } from "../src/utils";
import { safeFileName } from "../src/state-dir";

test("computeToolsHash is order-insensitive and change-sensitive", () => {
  const a = { name: "a", description: "x", inputSchema: { properties: { p: { type: "string" } } } };
  const b = { name: "b", description: "y", inputSchema: {} };
  assert.equal(computeToolsHash([a, b]), computeToolsHash([b, a]));

  const aNested = structuredClone(a);
  (aNested.inputSchema.properties.p as { description?: string }).description = "poisoned";
  assert.notEqual(computeToolsHash([a, b]), computeToolsHash([aNested, b]));
});

test("classifyTool trust levels", () => {
  assert.equal(classifyTool("db__drop_table"), "high");
  assert.equal(classifyTool("db__delete_user"), "high");
  assert.equal(classifyTool("db__create_row"), "medium");
  assert.equal(classifyTool("k8s__execute_command"), "medium");
  assert.equal(classifyTool("db__list_tables"), "low");
});

test("extractFields reads top-level schema properties", () => {
  assert.deepEqual(extractFields({ properties: { a: {}, b: {} } }), ["a", "b"]);
  assert.deepEqual(extractFields("not a schema"), []);
});

test("downstreamEnv never leaks gateway credentials or arbitrary host env", () => {
  process.env.VENGTOO_API_KEY = "vgt_super_secret";
  process.env.VENGTOO_GATEWAY_HTTP_TOKENS = "tok1,tok2";
  process.env.SOME_CLOUD_CREDENTIAL = "aws-ish-secret";
  try {
    const env = downstreamEnv({ DB_URL: "postgres://x" });
    assert.equal(env.VENGTOO_API_KEY, undefined, "gateway API key must not reach downstreams");
    assert.equal(env.VENGTOO_GATEWAY_HTTP_TOKENS, undefined, "HTTP tokens must not reach downstreams");
    assert.equal(env.SOME_CLOUD_CREDENTIAL, undefined, "arbitrary host env must not be inherited");
    assert.equal(env.DB_URL, "postgres://x", "explicit per-server env must pass through");
  } finally {
    delete process.env.VENGTOO_API_KEY;
    delete process.env.VENGTOO_GATEWAY_HTTP_TOKENS;
    delete process.env.SOME_CLOUD_CREDENTIAL;
  }
});

test("explicit per-server VENGTOO_* env is honored (operator intent)", () => {
  const env = downstreamEnv({ VENGTOO_AGENT_URL: "http://127.0.0.1:9999" });
  assert.equal(env.VENGTOO_AGENT_URL, "http://127.0.0.1:9999");
});

test("safeFileName neutralizes path separators", () => {
  assert.equal(safeFileName("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeFileName("my-server.v2"), "my-server.v2");
});
