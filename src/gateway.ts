import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { GatewayConfig, ServerConfig } from "./types";
import { authorize } from "./authorize";
import { filterVisibleTools } from "./filter-tools";
import { AuditLog, generateRequestId } from "./audit";
import { syncAllServers, fetchEnforcedTools } from "./sync";
import { getOrCreateGatewayId } from "./gateway-id";
import { startHttpServer, resolveHttpOptions } from "./http-server";
import { downstreamEnv } from "./utils";
import { saveEnforced, loadEnforced } from "./enforced-store";

export interface DownstreamServer {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
}

interface ToolEntry {
  downstream: DownstreamServer;
  originalName: string;
}

/**
 * Shared, transport-independent gateway state. Downstream MCP servers are
 * spawned once and multiplexed across every caller — whether that caller
 * arrives over stdio (one process) or HTTP (many concurrent sessions). Each
 * session gets its own MCP `Server` via {@link createConfiguredServer}, but all
 * of them close over this single context, so a block/drift decision applies
 * uniformly regardless of how the caller connected.
 */
export interface GatewayContext {
  config: GatewayConfig;
  downstreams: DownstreamServer[];
  toolIndex: Map<string, ToolEntry>;
  audit: AuditLog;
  /** Mutated in place as the cloud reports blocks — never reassigned, so every
   *  per-session server observes the same live set. */
  blockedTools: Set<string>;
  /** Tools discovered but never approved (held for review). Denied at the
   *  gateway with a distinct tool_pending_review reason. Same live-reference
   *  contract as blockedTools. */
  pendingTools: Set<string>;
  /**
   * Resolves once the initial enforcement state (blocked/pending) has been
   * loaded — the fail-closed startup gate. CallTool awaits this (bounded by
   * {@link READY_TIMEOUT_MS}) before consulting blockedTools/pendingTools, so an
   * unapproved/blocked tool can't slip through the window between "serving" and
   * "enforcement state loaded". Resolved immediately in local/standalone mode
   * (no cloud governance to load). Absent (undefined) in unit tests → gate is a
   * no-op. Never rejects — a failed restore still resolves it (see startGateway).
   */
  ready?: Promise<void>;
}

/** Max time CallTool waits for the startup enforcement-state load before failing
 *  closed. Kept short so a healthy start is imperceptible, but a hung/unreachable
 *  sync denies (rather than fails open) until it settles. Override for tests via
 *  VENGTOO_READY_TIMEOUT_MS. */
const READY_TIMEOUT_MS = 5_000;

function readyTimeoutMs(): number {
  const v = Number(process.env.VENGTOO_READY_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : READY_TIMEOUT_MS;
}

/** Races the ready promise against a bounded timeout. Returns "ready" if the
 *  gate opened in time, "timeout" otherwise. The guard timer is unref'd so it
 *  never keeps the process alive on its own. */
function awaitReady(ready: Promise<void>, ms: number): Promise<"ready" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (outcome: "ready" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => done("timeout"), ms);
    (timer as { unref?: () => void }).unref?.();
    // ready never rejects, but treat a rejection as "ready" defensively so a
    // programming error can't wedge every call into a permanent timeout deny.
    ready.then(() => done("ready"), () => done("ready"));
  });
}

export async function startGateway(config: GatewayConfig): Promise<void> {
  process.on("unhandledRejection", (err) => {
    console.error("[vengtoo-gateway] unhandled rejection:", err);
  });

  const downstreams = await spawnDownstreams(config.servers);
  const toolIndex = buildToolIndex(downstreams);
  const audit = new AuditLog();
  const gatewayId = getOrCreateGatewayId();
  const blockedTools = new Set<string>();
  const pendingTools = new Set<string>();

  // Fail-closed startup gate. CallTool awaits `ready` before consulting the
  // blocked/pending sets, so no tool can be invoked in the window between "the
  // server is accepting requests" and "enforcement state has been loaded".
  let resolveReady!: () => void;
  const ready = new Promise<void>((res) => { resolveReady = res; });

  // Local/standalone mode has no cloud governance to load (no blocked/pending
  // concept), so the gate must be a no-op — open it immediately and don't make
  // these gateways wait. Cloud sync still runs below (hashes/snapshots/drift).
  const hasCloudGovernance = Boolean(config.vengtoo.apiKey);
  if (!hasCloudGovernance) resolveReady();

  // Seed the enforcement sets from the cloud, then fold in the change-triggered
  // sync — the whole restore runs in the background and OPENS THE GATE when done
  // (or on error, so a failed restore can't wedge the gate shut forever; the
  // CallTool timeout still fails closed while the restore is in flight).
  const restore = async () => {
    // syncAllServers reports blocks/pending only for servers whose tools CHANGED,
    // so on an unchanged restart it returns nothing — without this seed, a
    // previously-blocked (drifted) tool or a held-for-review tool would silently
    // become callable again after any restart.
    try {
      const restored = await fetchEnforcedTools(config, gatewayId);
      for (const t of restored.blocked) blockedTools.add(t);
      for (const t of restored.pending) pendingTools.add(t);
      if (blockedTools.size > 0 || pendingTools.size > 0) {
        console.error(
          `[vengtoo-gateway] restored ${blockedTools.size} blocked + ${pendingTools.size} pending tool(s) from cloud`
        );
      }
      // Cache the verdict locally so a future restart during a cloud outage
      // fails DEGRADED (keeps enforcing these blocks) instead of failing OPEN.
      saveEnforced(blockedTools, pendingTools);
    } catch (err) {
      console.error(
        "[vengtoo-gateway] could not restore enforced tools from cloud:",
        err instanceof Error ? err.message : err
      );
      // Fall back to the last verdict this gateway saw. Matters in split-plane
      // deployments (policy via local agent, enforcement via cloud): without
      // this, cloud-down-at-restart would silently un-block drifted tools.
      const cached = loadEnforced();
      for (const t of cached.blocked) blockedTools.add(t);
      for (const t of cached.pending) pendingTools.add(t);
      if (blockedTools.size > 0 || pendingTools.size > 0) {
        console.error(
          `[vengtoo-gateway] enforcing last known verdict from local cache: ${blockedTools.size} blocked + ${pendingTools.size} pending tool(s)`
        );
      }
    }

    // Fold in any additional blocks/pending discovered by the change-triggered sync.
    try {
      const { blocked, pending } = await syncAllServers(config, downstreams);
      for (const t of blocked) blockedTools.add(t);
      for (const t of pending) pendingTools.add(t);
      if (blocked.size > 0 || pending.size > 0) {
        saveEnforced(blockedTools, pendingTools);
      }
    } catch (err) {
      console.error("[vengtoo-gateway] tool sync warning:", err instanceof Error ? err.message : err);
    }
  };

  restore().finally(() => resolveReady());

  const ctx: GatewayContext = { config, downstreams, toolIndex, audit, blockedTools, pendingTools, ready };

  let closeHttp: (() => Promise<void>) | undefined;
  const shutdown = async () => {
    if (closeHttp) { try { await closeHttp(); } catch { /* best effort */ } }
    for (const ds of downstreams) {
      try { await ds.transport.close(); } catch { /* best effort */ }
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (config.transport === "http") {
    const opts = resolveHttpOptions(config);
    closeHttp = await startHttpServer(ctx, opts);
    console.error(
      `[vengtoo-gateway] running over HTTP — ${downstreams.length} server(s), ${toolIndex.size} tool(s)`
    );
    return;
  }

  const server = createConfiguredServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[vengtoo-gateway] running — ${downstreams.length} server(s), ${toolIndex.size} tool(s)`);
}

/**
 * Builds an MCP `Server` wired to the gateway's list/call handlers. Called once
 * per stdio process and once per HTTP session; the returned server holds no
 * state of its own — everything lives in the shared {@link GatewayContext}.
 *
 * `subjectOverride` is the per-caller identity resolved from the HTTP bearer
 * token (http.callers). When set, this session's calls are authorized and
 * audited as that subject; otherwise the config's global subject applies
 * (stdio mode, anonymous tokens, open loopback).
 */
export function createConfiguredServer(ctx: GatewayContext, subjectOverride?: string): Server {
  const { config, downstreams, toolIndex, audit, blockedTools, pendingTools, ready } = ctx;
  const subject = subjectOverride ?? config.subject;

  const server = new Server(
    { name: "vengtoo-mcp-gateway", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Don't advertise the catalog before blocked/pending are known — otherwise a
    // just-started gateway could list a tool it's about to refuse. If the gate
    // times out we still fall through and filter with whatever is loaded so far
    // (fail-safe: at worst a soon-to-be-blocked tool is briefly listed, but the
    // CallTool gate below still denies it).
    if (ready) await awaitReady(ready, readyTimeoutMs());

    const tools = [];
    for (const ds of downstreams) {
      for (const tool of ds.tools) {
        const qn = qualifiedName(ds.name, tool.name);
        // Don't advertise tools the gateway will refuse anyway — listing a
        // blocked/pending tool just makes the model attempt it and burn a
        // round-trip on a guaranteed deny. (Calls are still denied even if a
        // client cached an earlier listing.)
        if (blockedTools.has(qn) || pendingTools.has(qn)) continue;
        tools.push({
          name: qn,
          description: `[${ds.name}] ${tool.description ?? ""}`.trim(),
          inputSchema: tool.inputSchema,
        });
      }
    }
    // Per-identity visibility — when enabled, advertise only the tools this
    // subject may invoke (tool-level; arg conditions stay enforced at call time).
    // Additive + fail-open by default, so it can't blank the toolset on a blip.
    const visible = config.vengtoo.filterToolsList
      ? await filterVisibleTools(config, subject, tools)
      : tools;
    return { tools: visible };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const fullName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const requestId = generateRequestId();

    // Fail-closed startup gate: hold the call until enforcement state (blocked/
    // pending) has loaded, so the checks below can't match an empty set during
    // the startup window. If the load hangs/is unreachable past the timeout,
    // DENY (do not fall through) — a still-initializing gateway must not let an
    // unapproved or blocked tool run. In local mode `ready` is already resolved.
    if (ready) {
      const state = await awaitReady(ready, readyTimeoutMs());
      if (state === "timeout") {
        audit.record({
          requestId,
          subject,
          tool: fullName,
          args,
          allowed: false,
          reason: "gateway_initializing",
          latencyMs: 0,
          timestamp: new Date().toISOString(),
        });
        return {
          content: [{ type: "text", text: `[Vengtoo] Gateway is still initializing — retry shortly.` }],
          isError: true,
        };
      }
    }

    const entry = toolIndex.get(fullName);

    if (!entry) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${fullName}` }],
        isError: true,
      };
    }

    if (blockedTools.has(fullName)) {
      // The gateway only knows the tool is blocked, not why (drift vs. an admin's
      // manual block) — the cloud doesn't send the reason with the block set. Keep
      // the message reason-neutral rather than asserting "schema drift".
      audit.record({
        requestId,
        subject,
        tool: fullName,
        args,
        allowed: false,
        reason: "tool_blocked — awaiting admin re-approval",
        latencyMs: 0,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `[Vengtoo] Tool "${fullName}" is blocked. An admin must re-approve it in the Vengtoo console before it can be called.` }],
        isError: true,
      };
    }

    // Held for review: a newly-discovered tool that has never been approved is
    // denied with a distinct reason (fail-closed) until an admin approves it —
    // a distinct governance state, not the same as a policy deny or a drift block.
    if (pendingTools.has(fullName)) {
      audit.record({
        requestId,
        subject,
        tool: fullName,
        args,
        allowed: false,
        reason: "tool_pending_review",
        latencyMs: 0,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `[Vengtoo] Tool "${fullName}" is pending review — it was discovered but has not yet been approved. An admin must approve it in the Vengtoo console before it can be called.` }],
        isError: true,
      };
    }

    const start = performance.now();
    const result = await authorize(config, subject, fullName, args);
    const latencyMs = Math.round(performance.now() - start);

    if (!result.allowed) {
      const reason = result.reason ?? "denied by policy";
      audit.record({
        requestId,
        subject,
        tool: fullName,
        args,
        allowed: false,
        reason,
        latencyMs,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `[Vengtoo] Access denied: tool "${fullName}" was blocked by Vengtoo authorization policy. Reason: ${reason}` }],
        isError: true,
      };
    }

    try {
      const result = await entry.downstream.client.callTool({
        name: entry.originalName,
        arguments: args,
      });
      audit.record({
        requestId,
        subject,
        tool: fullName,
        args,
        allowed: true,
        // End-to-end latency (authorize + downstream execution), not just the
        // authorize round-trip — this is what a dashboard user expects.
        latencyMs: Math.round(performance.now() - start),
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      audit.record({
        requestId,
        subject,
        tool: fullName,
        args,
        allowed: true,
        reason: `downstream error: ${message}`,
        latencyMs: Math.round(performance.now() - start),
        timestamp: new Date().toISOString(),
      });
      return {
        content: [{ type: "text", text: `Downstream server error for "${fullName}": ${message}` }],
        isError: true,
      };
    }
  });

  return server;
}

async function spawnDownstreams(
  servers: Record<string, ServerConfig>
): Promise<DownstreamServer[]> {
  const results: DownstreamServer[] = [];

  for (const [name, cfg] of Object.entries(servers)) {
    console.error(`[vengtoo-gateway] connecting to ${name}: ${cfg.command} ${(cfg.args ?? []).join(" ")}`);
    // Filtered env: downstreams never see the gateway's credentials or the
    // host's full environment (see downstreamEnv in utils.ts).
    const transport = new StdioClientTransport({
      command: cfg.command,
      args: cfg.args,
      env: downstreamEnv(cfg.env),
    });
    const client = new Client(
      { name: `vengtoo-gateway/${name}`, version: "0.1.0" },
      { capabilities: {} }
    );
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.error(`[vengtoo-gateway] ${name}: ${tools.length} tool(s) registered`);

    results.push({
      name,
      client,
      transport,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  return results;
}

function buildToolIndex(downstreams: DownstreamServer[]): Map<string, ToolEntry> {
  const index = new Map<string, ToolEntry>();
  for (const ds of downstreams) {
    for (const tool of ds.tools) {
      const qn = qualifiedName(ds.name, tool.name);
      index.set(qn, { downstream: ds, originalName: tool.name });
    }
  }
  return index;
}

function qualifiedName(serverName: string, toolName: string): string {
  return `${serverName}__${toolName}`;
}
