import type { GatewayConfig, DriftEvent, ToolSnapshot } from "./types";
import { computeToolsHash, hasChanged, saveHash } from "./hash";
import { loadSnapshot, saveSnapshot } from "./snapshot";
import { detectDrift, logDriftEvents } from "./drift";
import { getOrCreateGatewayId } from "./gateway-id";
import type { DiscoveredTool } from "./utils";

const SYNC_TIMEOUT_MS = 10_000;
const DEFAULT_CLOUD_BASE = "https://api.vengtoo.com";

interface SyncResponse {
  synced: number;
  created: number;
  updated: number;
  unchanged: number;
  gateway_id: string;
  server: string;
  drifted_count?: number;
  blocked_tools?: string[];
  pending_tools?: string[];
}

/**
 * Tools the gateway must refuse, keyed by qualified name. `blocked` = drift-
 * blocked or admin-blocked; `pending` = never approved (held for review).
 * Blocked takes precedence when a tool is both.
 */
export interface EnforcedTools {
  blocked: Set<string>;
  pending: Set<string>;
}

interface DownstreamLike {
  name: string;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

export async function syncAllServers(
  config: GatewayConfig,
  downstreams: DownstreamLike[]
): Promise<EnforcedTools> {
  const gatewayId = getOrCreateGatewayId();
  const blockedTools = new Set<string>();
  const pendingTools = new Set<string>();
  console.error(`[vengtoo-gateway] gateway id: ${gatewayId}`);

  for (const ds of downstreams) {
    const hash = computeToolsHash(ds.tools);

    const toolSnapshots: ToolSnapshot[] = ds.tools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: t.inputSchema,
    }));

    let driftEvents: DriftEvent[] = [];
    const oldSnapshot = loadSnapshot(ds.name);

    if (oldSnapshot && hasChanged(ds.name, hash)) {
      driftEvents = detectDrift(ds.name, oldSnapshot, toolSnapshots);
      if (driftEvents.length > 0) {
        logDriftEvents(driftEvents);
      }
    }

    if (!hasChanged(ds.name, hash) && oldSnapshot) {
      console.error(`[vengtoo-gateway] tools unchanged for '${ds.name}' — skipping sync`);
      continue;
    }

    const schemas = new Map<string, unknown>();
    const discovered: DiscoveredTool[] = ds.tools.map((t) => {
      const qn = `${ds.name}__${t.name}`;
      schemas.set(qn, t.inputSchema);
      return {
        qualifiedName: qn,
        server: ds.name,
        originalName: t.name,
        description: t.description ?? "",
        inputFields: [],
      };
    });

    if (config.vengtoo.apiKey) {
      try {
        const result = await syncToolsToCloud(
          config,
          gatewayId,
          ds.name,
          discovered,
          schemas,
          hash,
          driftEvents
        );
        if (result) {
          saveHash(ds.name, hash);
          saveSnapshot(ds.name, toolSnapshots, hash);
          console.error(
            `[vengtoo-gateway] synced ${result.synced} tools for '${ds.name}' (${result.created} created, ${result.updated} updated, ${result.unchanged} unchanged)`
          );
          if (result.drifted_count && result.drifted_count > 0) {
            console.error(
              `[vengtoo-gateway] ${result.drifted_count} tool(s) drifted from approved baseline for '${ds.name}'`
            );
          }
          if (result.blocked_tools) {
            for (const tool of result.blocked_tools) {
              blockedTools.add(`${ds.name}__${tool}`);
            }
          }
          if (result.pending_tools) {
            for (const tool of result.pending_tools) {
              pendingTools.add(`${ds.name}__${tool}`);
            }
            if (result.pending_tools.length > 0) {
              console.error(
                `[vengtoo-gateway] ${result.pending_tools.length} tool(s) pending review for '${ds.name}' — calls denied until approved`
              );
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[vengtoo-gateway] cloud sync failed for '${ds.name}' — ${msg}`);
      }
    } else {
      saveHash(ds.name, hash);
      saveSnapshot(ds.name, toolSnapshots, hash);
      if (config.vengtoo.blockOnDrift && driftEvents.length > 0) {
        // Local mode (no cloud to score severity): block any tool whose schema
        // drifted from the approved baseline. This is a facts-based rule ("it
        // changed") rather than a gateway-side severity judgment.
        for (const e of driftEvents) {
          blockedTools.add(`${ds.name}__${e.toolName}`);
        }
        console.error(
          `[vengtoo-gateway] blockOnDrift enabled — ${blockedTools.size} tool(s) blocked locally (any drift)`
        );
      }
    }
  }

  return { blocked: blockedTools, pending: pendingTools };
}

async function syncToolsToCloud(
  config: GatewayConfig,
  gatewayId: string,
  serverName: string,
  tools: DiscoveredTool[],
  schemas: Map<string, unknown>,
  hash: string,
  driftEvents: DriftEvent[]
): Promise<SyncResponse | null> {
  const baseUrl = resolveBaseUrl(config);
  const url = `${baseUrl}/v1/gateways/${gatewayId}/tools/sync`;

  // Facts-only payload: name, description, schema. Trust/risk is deliberately
  // NOT sent — the cloud classifies it in the trusted plane. The gateway is the
  // least-trusted component and must not author judgments.
  const body = {
    server: serverName,
    tools: tools.map((t) => ({
      name: t.originalName,
      description: t.description,
      schema: schemas.get(t.qualifiedName) ?? {},
    })),
    hash,
    drift_events: driftEvents.length > 0 ? driftEvents : undefined,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const auth = resolveAuth(config);
  if (auth) headers["Authorization"] = auth;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[vengtoo-gateway] sync returned ${res.status}: ${text}`);
      return null;
    }
    return (await res.json()) as SyncResponse;
  } finally {
    clearTimeout(timeout);
  }
}

interface DriftedToolsResponse {
  tools?: Array<{ qualified_name?: string; blocked?: boolean; pending?: boolean }>;
  count?: number;
}

/**
 * Fetches the gateway's currently-enforced tools (blocked + pending) from the
 * cloud.
 *
 * The gateway holds these sets in memory only. That memory is lost on restart,
 * and syncAllServers reports them *only* for servers whose tool hash CHANGED —
 * so an unchanged restart returns nothing and would silently un-block a
 * previously-blocked tool or make a pending tool callable again. Seeding from
 * this call on startup makes enforcement survive restarts.
 *
 * Reuses the GET /tools/drifted endpoint (which returns drifted, blocked, OR
 * pending tools). Returns empty sets when unauthenticated or on any error — the
 * authoritative state is re-established by the cloud on the next tool change,
 * and calls still fall through to a live policy check, so a failed read is safe.
 */
export async function fetchEnforcedTools(
  config: GatewayConfig,
  gatewayId: string
): Promise<EnforcedTools> {
  const blocked = new Set<string>();
  const pending = new Set<string>();
  const auth = resolveAuth(config);
  if (!auth) return { blocked, pending };

  const baseUrl = resolveBaseUrl(config);
  const url = `${baseUrl}/v1/gateways/${gatewayId}/tools/drifted`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: auth },
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(`[vengtoo-gateway] fetch enforced tools returned ${res.status}`);
      return { blocked, pending };
    }
    const body = (await res.json()) as DriftedToolsResponse;
    for (const t of body.tools ?? []) {
      if (!t.qualified_name) continue;
      // Blocked takes precedence over pending when a tool is both.
      if (t.blocked) blocked.add(t.qualified_name);
      else if (t.pending) pending.add(t.qualified_name);
    }
    return { blocked, pending };
  } finally {
    clearTimeout(timeout);
  }
}

function resolveBaseUrl(config: GatewayConfig): string {
  if (config.vengtoo.cloudUrl) {
    const url = new URL(config.vengtoo.cloudUrl);
    return `${url.protocol}//${url.host}`;
  }
  return DEFAULT_CLOUD_BASE;
}

function resolveAuth(config: GatewayConfig): string | undefined {
  if (config.vengtoo.apiKey) return `Bearer ${config.vengtoo.apiKey}`;
  if (config.vengtoo.clientId && config.vengtoo.clientSecret) {
    return `Basic ${Buffer.from(`${config.vengtoo.clientId}:${config.vengtoo.clientSecret}`).toString("base64")}`;
  }
  return undefined;
}
