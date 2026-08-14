import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";
import { createHash } from "crypto";

/**
 * Per-tenant namespace for sync state. All machine-local state used to be keyed
 * only by machine — so pointing the same machine at a different tenant (a new
 * VENGTOO_API_KEY) reused the previous tenant's cached tool hashes/snapshots,
 * and the gateway would log "tools unchanged — skipping sync" and never
 * register with the new tenant. Namespacing the sync state by a hash of the API
 * key makes hashes/snapshots/enforced state fresh per tenant.
 *
 * Set once at startup via {@link setStateNamespace}. Defaults to "default" so
 * standalone/local gateways (no API key) keep a single stable namespace.
 */
let _namespace = "default";

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Set the per-tenant namespace from the active API key. Call once at startup,
 *  AFTER any VENGTOO_API_KEY env override has been applied. No key → "default". */
export function setStateNamespace(apiKey?: string): void {
  _namespace = apiKey ? "t_" + sha256Hex(apiKey).slice(0, 12) : "default";
}

/** The current namespace segment (for logging/debuggability). */
export function stateNamespace(): string {
  return _namespace;
}

function stateBase(): string {
  return process.env.VENGTOO_STATE_DIR ?? join(homedir(), ".vengtoo");
}

/**
 * Directory for the gateway's per-tenant sync state (tool snapshots, hashes,
 * enforced-tool cache). Namespaced by the active API key (see
 * {@link setStateNamespace}) so switching tenants starts from a clean baseline
 * instead of reusing the previous tenant's cached hashes.
 *
 * Lives under the user's home directory — NOT process.cwd() — because MCP
 * clients launch the gateway with an unpredictable working directory (Claude
 * Desktop uses "/"). A cwd-keyed store would mint a fresh gateway identity and
 * drift baseline per launch directory, and crash outright on a read-only cwd.
 *
 * Override the root with VENGTOO_STATE_DIR (e.g. a mounted volume in containers).
 */
export function stateDir(...sub: string[]): string {
  return join(stateBase(), _namespace, ...sub);
}

/**
 * Directory for GLOBAL (non-namespaced) state that must survive key rotation —
 * currently just the gateway identity. Keeping gateway.id global means rotating
 * an API key or reinstalling does NOT mint a duplicate gateway in the cloud.
 * This preserves the legacy `~/.vengtoo/gateway.id` location.
 */
export function stateDirGlobal(...sub: string[]): string {
  return join(stateBase(), ...sub);
}

/** Creates dir (recursively) if missing and returns it. Throws on failure —
 *  callers that must not crash should catch and degrade. */
export function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Server names come from operator config keys, but they become filenames —
 *  normalize anything that isn't filename-safe so a name like "a/b" can't
 *  escape the state directory. */
export function safeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}
