import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname } from "path";
import { stateDir, ensureDir } from "./state-dir";
import type { EnforcedTools } from "./sync";

interface EnforcedFile {
  blocked: string[];
  pending: string[];
  savedAt: string;
}

/**
 * Local cache of the cloud's enforced-tools verdict (blocked + pending).
 *
 * Why it exists: the gateway holds these sets in memory only, and the startup
 * seed comes from the cloud. If the cloud is unreachable exactly when the
 * gateway restarts, an empty seed would silently un-block previously
 * drift-blocked tools — which matters in split-plane deployments where policy
 * checks go to a local agent that knows nothing about drift. Persisting the
 * last known verdict lets a restart fail DEGRADED (keep enforcing the last
 * known blocks) instead of failing OPEN.
 *
 * Best-effort on both sides: a write failure only logs (enforcement still
 * works for this process), and a corrupt file reads as empty.
 */
export function saveEnforced(blocked: Set<string>, pending: Set<string>): void {
  try {
    const path = enforcedPath();
    ensureDir(dirname(path));
    const file: EnforcedFile = {
      blocked: [...blocked].sort(),
      pending: [...pending].sort(),
      savedAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(file, null, 2), "utf-8");
  } catch (err) {
    console.error(
      "[vengtoo-gateway] could not persist enforced-tools cache:",
      err instanceof Error ? err.message : err
    );
  }
}

export function loadEnforced(): EnforcedTools {
  const blocked = new Set<string>();
  const pending = new Set<string>();
  try {
    const path = enforcedPath();
    if (!existsSync(path)) return { blocked, pending };
    const file = JSON.parse(readFileSync(path, "utf-8")) as EnforcedFile;
    for (const t of file.blocked ?? []) blocked.add(t);
    for (const t of file.pending ?? []) pending.add(t);
  } catch {
    // Corrupt cache — treat as empty; the next successful cloud read rewrites it.
  }
  return { blocked, pending };
}

function enforcedPath(): string {
  return stateDir("enforced.json");
}
