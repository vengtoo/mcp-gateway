import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import type { ServerSnapshot, ToolSnapshot } from "./types";
import { stateDir, ensureDir, safeFileName } from "./state-dir";

export function saveSnapshot(
  serverName: string,
  tools: ToolSnapshot[],
  hash: string
): void {
  ensureDir(stateDir("snapshots"));
  const snapshot: ServerSnapshot = {
    server: serverName,
    hash,
    tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)),
    capturedAt: new Date().toISOString(),
  };
  writeFileSync(snapshotPath(serverName), JSON.stringify(snapshot, null, 2), "utf-8");
}

export function loadSnapshot(serverName: string): ServerSnapshot | null {
  const path = snapshotPath(serverName);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as ServerSnapshot;
  } catch {
    return null;
  }
}

function snapshotPath(serverName: string): string {
  return join(stateDir("snapshots"), `${safeFileName(serverName)}.json`);
}
