import type { GatewayConfig } from "./types";

// Per-identity tools/list filtering.
//
// Keep only the tools the caller's subject is authorized to INVOKE. This is
// tool-LEVEL visibility: argument-level conditions (e.g. a destructive-SQL deny)
// can't be evaluated here because arguments are unknown at list time, so a tool
// that is "allowed except for destructive args" still appears — the agent *can*
// invoke it — and the argument gate is applied at call time by ext-authz.
//
// Failure policy is FAIL OPEN by default (return the unfiltered list): call-time
// ext-authz still blocks unauthorized invocations, so a transient authz blip
// must not blank the agent's entire toolset. Set filterToolsListFailClosed to
// hide everything on error instead.

type Tool = { name: string; description?: string; inputSchema: unknown };

interface BatchDecision {
  decision?: boolean;
  allowed?: boolean;
}
interface BatchResponse {
  evaluations?: BatchDecision[];
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_ENDPOINT = "https://api.vengtoo.com/access/v1/evaluations";

export async function filterVisibleTools(
  config: GatewayConfig,
  subject: string,
  tools: Tool[]
): Promise<Tool[]> {
  if (tools.length === 0) return tools;

  try {
    const decisions = await batchAuthorizeInvoke(config, subject, tools.map((t) => t.name));
    if (decisions.length !== tools.length) {
      // Length mismatch means we can't safely map decisions to tools — don't guess.
      throw new Error(`batch evaluations length ${decisions.length} != ${tools.length} tools`);
    }
    return tools.filter((_, i) => decisions[i]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (config.vengtoo.filterToolsListFailClosed) {
      console.error(`[vengtoo-gateway] tools/list authz failed — failing CLOSED (hiding all tools): ${msg}`);
      return [];
    }
    console.error(`[vengtoo-gateway] tools/list authz failed — failing OPEN (unfiltered list): ${msg}`);
    return tools;
  }
}

// One boxcarred AuthZEN batch: subject + action as top-level defaults, one
// evaluation per tool overriding only the resource. Returns decisions in order.
async function batchAuthorizeInvoke(
  config: GatewayConfig,
  subject: string,
  toolNames: string[]
): Promise<boolean[]> {
  const body = {
    subject: { type: config.subjectType ?? "ai_agent", id: subject },
    action: { name: "invoke" },
    evaluations: toolNames.map((name) => ({
      resource: { type: config.resourceType ?? "mcp_tool", name },
    })),
  };

  const url = batchEndpoint(config);
  const timeoutMs = config.vengtoo.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const auth = authHeader(config);
  if (auth) headers["Authorization"] = auth;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const data = (await res.json()) as BatchResponse;
    const evals = data.evaluations ?? [];
    return evals.map((d) => d.decision ?? d.allowed ?? false);
  } finally {
    clearTimeout(t);
  }
}

// The /access/v1/evaluations (batch) sibling of the eval endpoint, derived from
// the same agent/cloud config the single-eval path uses.
function batchEndpoint(config: GatewayConfig): string {
  const a = config.vengtoo;
  const base = a.agentUrl ?? a.cloudUrl;
  if (base) {
    const b = base.replace(/\/$/, "");
    if (b.endsWith("/access/v1/evaluations")) return b;
    if (b.endsWith("/access/v1/evaluation")) return `${b}s`;
    return `${b}/access/v1/evaluations`;
  }
  return DEFAULT_BATCH_ENDPOINT;
}

function authHeader(config: GatewayConfig): string | undefined {
  const a = config.vengtoo;
  if (a.apiKey) return `Bearer ${a.apiKey}`;
  if (a.clientId && a.clientSecret) {
    return `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`;
  }
  return undefined;
}
