import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateGatewayId } from "../src/gateway-id";
import { saveEnforced, loadEnforced } from "../src/enforced-store";
import { saveHash, hasChanged } from "../src/hash";
import { saveSnapshot, loadSnapshot } from "../src/snapshot";
import { setStateNamespace } from "../src/state-dir";

let dir: string;
const dirs: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "vengtoo-state-"));
  dirs.push(dir);
  process.env.VENGTOO_STATE_DIR = dir;
  setStateNamespace(undefined); // reset to the "default" namespace between tests
});

after(() => {
  delete process.env.VENGTOO_STATE_DIR;
  setStateNamespace(undefined);
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

test("gateway id is minted once and stable across calls", () => {
  const id1 = getOrCreateGatewayId();
  const id2 = getOrCreateGatewayId();
  assert.match(id1, /^gw_[0-9a-f]{16}$/);
  assert.equal(id1, id2);
  assert.equal(readFileSync(join(dir, "gateway.id"), "utf-8").trim(), id1);
});

test("unwritable state dir degrades to an ephemeral id instead of crashing", () => {
  process.env.VENGTOO_STATE_DIR = "/dev/null/not-a-dir"; // mkdir will fail
  const id = getOrCreateGatewayId();
  assert.match(id, /^gw_[0-9a-f]{16}$/, "must still return a usable id");
});

test("enforced-tools cache round-trips", () => {
  saveEnforced(new Set(["db__drop", "db__wipe"]), new Set(["db__new"]));
  const loaded = loadEnforced();
  assert.deepEqual([...loaded.blocked].sort(), ["db__drop", "db__wipe"]);
  assert.deepEqual([...loaded.pending], ["db__new"]);
});

test("enforced-tools cache reads empty when absent", () => {
  const loaded = loadEnforced();
  assert.equal(loaded.blocked.size, 0);
  assert.equal(loaded.pending.size, 0);
});

test("hash store detects change and persists under the state dir", () => {
  assert.equal(hasChanged("db", "aaa"), true, "no stored hash → changed");
  saveHash("db", "aaa");
  assert.equal(hasChanged("db", "aaa"), false);
  assert.equal(hasChanged("db", "bbb"), true);
  // Sync state is namespaced (default namespace when no API key is set).
  assert.equal(existsSync(join(dir, "default", "hashes", "db.hash")), true);
});

test("switching API-key namespace isolates sync state (fixes skip-sync on tenant switch)", () => {
  // Tenant A caches a hash for 'db'.
  setStateNamespace("apikey-tenant-A");
  saveHash("db", "hashA");
  assert.equal(hasChanged("db", "hashA"), false, "same tenant sees its cached hash");

  // Point the same machine at a new tenant: the cached hash must NOT leak in,
  // so the gateway re-syncs instead of logging "tools unchanged — skipping".
  setStateNamespace("apikey-tenant-B");
  assert.equal(hasChanged("db", "hashA"), true, "new tenant must not reuse tenant A's hash");

  // Back to tenant A: its state is still there (each tenant has its own dir).
  setStateNamespace("apikey-tenant-A");
  assert.equal(hasChanged("db", "hashA"), false, "tenant A state survives the switch");
});

test("gateway id stays GLOBAL across API-key rotation (no duplicate gateway)", () => {
  setStateNamespace("apikey-tenant-A");
  const id1 = getOrCreateGatewayId();
  // Rotate the key / switch tenant namespace.
  setStateNamespace("apikey-tenant-B");
  const id2 = getOrCreateGatewayId();
  assert.equal(id2, id1, "gateway id must not change when the API key changes");
  // It lives at the un-namespaced root, preserving the legacy location.
  assert.equal(readFileSync(join(dir, "gateway.id"), "utf-8").trim(), id1);
});

test("snapshot round-trips and sanitizes hostile server names", () => {
  const tools = [{ name: "t", description: "d", inputSchema: {} }];
  saveSnapshot("../evil", tools, "h1");
  const loaded = loadSnapshot("../evil");
  assert.equal(loaded?.hash, "h1");
  assert.equal(loaded?.tools.length, 1);
  assert.equal(existsSync(join(dir, "default", "snapshots", ".._evil.json")), true, "filename must be sanitized");
});
