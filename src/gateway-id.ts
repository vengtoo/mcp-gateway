import { randomUUID } from "crypto";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { stateDirGlobal, ensureDir } from "./state-dir";

/**
 * Stable identity for this gateway installation, used to key tool syncs and
 * enforcement lookups in the cloud.
 *
 * Stored under the home-directory state dir (see state-dir.ts). A legacy
 * `./.vengtoo/gateway.id` (the old cwd-keyed location) is still honored —
 * read and migrated forward — so existing installations keep their identity.
 *
 * Never throws: if the state dir is unwritable, the gateway runs with an
 * ephemeral id and a warning rather than refusing to start. Enforcement still
 * works; only cross-restart identity continuity is lost.
 */
export function getOrCreateGatewayId(): string {
  // GLOBAL (non-namespaced): the gateway identity must survive API-key rotation
  // and reinstall, otherwise every key change would mint a duplicate gateway in
  // the cloud. Only sync state (hashes/snapshots/enforced) is namespaced per key.
  const idFile = stateDirGlobal("gateway.id");
  try {
    if (existsSync(idFile)) {
      const id = readFileSync(idFile, "utf-8").trim();
      if (id) return id;
    }

    // Legacy location (pre-0.2: keyed to process.cwd()). Migrate forward.
    const legacyFile = join(process.cwd(), ".vengtoo", "gateway.id");
    let id: string | undefined;
    if (existsSync(legacyFile)) {
      const legacy = readFileSync(legacyFile, "utf-8").trim();
      if (legacy) id = legacy;
    }

    id ??= newId();
    ensureDir(dirname(idFile));
    writeFileSync(idFile, id, "utf-8");
    return id;
  } catch (err) {
    const ephemeral = newId();
    console.error(
      `[vengtoo-gateway] could not persist gateway id (${err instanceof Error ? err.message : err}) — using ephemeral id ${ephemeral} for this run`
    );
    return ephemeral;
  }
}

function newId(): string {
  return `gw_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
