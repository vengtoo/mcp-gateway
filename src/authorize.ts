import type { GatewayConfig, AuthorizeResult } from "./types";

const DEFAULT_CLOUD_URL = "https://api.vengtoo.com/access/v1/evaluation";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_HITL_POLL_MS = 5_000;
// Cap on how long a tool call blocks awaiting human approval. Kept under typical
// MCP client request timeouts (~60s) so the call returns before the client gives
// up; if the window is longer, the agent re-invokes to resume waiting on the
// same (still-live) approval. Overridable via vengtoo.approvalMaxWaitMs.
const DEFAULT_HITL_MAX_WAIT_MS = 50_000;

interface AuthZENResponse {
  decision?: boolean;
  allowed?: boolean;
  context?: {
    reason?: string;
    reason_code?: string;
    policy_id?: string;
    approval_id?: string;
    expires_in?: number; // seconds until the approval window lapses
    interval?: number;   // seconds the caller should wait between polls
  };
  reason?: string;
}

// A single evaluation outcome, including the HITL fields the poll loop needs.
interface Decision {
  allowed: boolean;
  reason?: string;
  reasonCode?: string;
  approvalId?: string;
  expiresInMs?: number;
  intervalMs?: number;
}

function normalize(raw: AuthZENResponse): Decision {
  const allowed = raw.decision ?? raw.allowed ?? false;
  const ctx = raw.context;
  return {
    allowed,
    reason: ctx?.reason ?? raw.reason,
    reasonCode: ctx?.reason_code,
    approvalId: ctx?.approval_id,
    expiresInMs: ctx?.expires_in != null ? ctx.expires_in * 1000 : undefined,
    intervalMs: ctx?.interval != null ? ctx.interval * 1000 : undefined,
  };
}

export async function authorize(
  config: GatewayConfig,
  subjectId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<AuthorizeResult> {
  const first = await evaluate(config, subjectId, toolName, args);

  // Human-in-the-loop: the cloud created (or found) a pending approval. Block
  // and poll the same request until it resolves, times out, or we hit the wait
  // cap. On retry the cloud short-circuits to the current approval status.
  if (first.reasonCode === "authorization_pending") {
    return waitForApproval(config, subjectId, toolName, args, first);
  }

  return toResult(first);
}

async function waitForApproval(
  config: GatewayConfig,
  subjectId: string,
  toolName: string,
  args: Record<string, unknown>,
  first: Decision
): Promise<AuthorizeResult> {
  const maxWaitMs = config.vengtoo.approvalMaxWaitMs ?? DEFAULT_HITL_MAX_WAIT_MS;
  // Never wait past the approval's own expiry, and never past our cap.
  const deadline = Date.now() + Math.min(maxWaitMs, first.expiresInMs ?? maxWaitMs);
  let interval = first.intervalMs ?? DEFAULT_HITL_POLL_MS;

  console.error(
    `[vengtoo-gateway] tool "${toolName}" is awaiting human approval (approval ${first.approvalId ?? "?"}) — blocking up to ${Math.round((deadline - Date.now()) / 1000)}s`
  );

  while (Date.now() < deadline) {
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;

    const d = await evaluate(config, subjectId, toolName, args);
    switch (d.reasonCode) {
      case "authorization_pending":
        interval = d.intervalMs ?? interval;
        continue;
      case "slow_down":
        // Polled faster than the cloud allows — back off to its suggested interval.
        interval = d.intervalMs ?? interval * 2;
        continue;
      default:
        // Terminal: approved_by_human (allowed) or a deny (denied/timeout).
        console.error(
          `[vengtoo-gateway] approval ${first.approvalId ?? "?"} resolved: ${d.allowed ? "APPROVED" : `DENIED (${d.reasonCode ?? "denied"})`}`
        );
        return toResult(d);
    }
  }

  // Window lapsed on our side before a decision. The approval may still be live
  // cloud-side, so tell the agent it can re-invoke to keep waiting.
  console.error(`[vengtoo-gateway] approval ${first.approvalId ?? "?"} still pending after wait cap`);
  return {
    allowed: false,
    reason:
      "awaiting human approval — not granted within the wait window. Re-invoke the tool to keep waiting for the approver.",
  };
}

/** Maps a terminal decision to the gateway's allow/deny result with a friendly reason. */
function toResult(d: Decision): AuthorizeResult {
  if (d.allowed) return { allowed: true };
  const reason =
    d.reason ??
    (d.reasonCode === "access_denied"
      ? "denied by approver"
      : d.reasonCode === "approval_timeout"
      ? "approval request timed out"
      : d.reasonCode) ??
    "denied by policy";
  return { allowed: false, reason };
}

// Performs a single evaluation, trying each configured endpoint in order and
// failing closed (deny) on any infra error.
async function evaluate(
  config: GatewayConfig,
  subjectId: string,
  toolName: string,
  args: Record<string, unknown>
): Promise<Decision> {
  const body = {
    subject: { type: config.subjectType ?? "ai_agent", id: subjectId },
    resource: { type: config.resourceType ?? "mcp_tool", name: toolName, attributes: args },
    action: { name: "invoke" },
  };
  const timeoutMs = config.vengtoo.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = authHeader(config);
  const endpoints = resolveEndpoints(config);

  let lastError: Error | undefined;
  for (let i = 0; i < endpoints.length; i++) {
    const url = endpoints[i];
    const isLast = i === endpoints.length - 1;
    try {
      const res = await postJson(url, body, auth, timeoutMs);
      if (res.ok) return normalize((await res.json()) as AuthZENResponse);
      const text = await safeText(res);
      if (res.status === 401) {
        return deny(`authentication failed — check your API key`);
      }
      if (res.status === 404) {
        return deny(`no authorization policy configured for this tool`);
      }
      if (res.status >= 500 && !isLast) {
        lastError = new Error(`${url}: ${res.status} ${text}`);
        continue;
      }
      return deny(`authorization service error (${res.status})`);
    } catch (err) {
      lastError = err as Error;
      if (isLast) break;
    }
  }
  console.error("[vengtoo-gateway] authorize failed:", lastError);
  return deny(`authz unreachable: ${lastError?.message ?? "unknown"}`);
}

function resolveEndpoints(config: GatewayConfig): string[] {
  const urls: string[] = [];
  const a = config.vengtoo;
  if (a.agentUrl) {
    const base = a.agentUrl.replace(/\/$/, "");
    urls.push(base.endsWith("/access/v1/evaluation") ? base : `${base}/access/v1/evaluation`);
  }
  if (a.cloudUrl) urls.push(a.cloudUrl);
  if (urls.length === 0) urls.push(DEFAULT_CLOUD_URL);
  return urls;
}

function authHeader(config: GatewayConfig): string | undefined {
  const a = config.vengtoo;
  if (a.apiKey) return `Bearer ${a.apiKey}`;
  if (a.clientId && a.clientSecret) {
    return `Basic ${Buffer.from(`${a.clientId}:${a.clientSecret}`).toString("base64")}`;
  }
  return undefined;
}

async function postJson(url: string, body: unknown, auth: string | undefined, timeoutMs: number): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (auth) headers["Authorization"] = auth;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function safeText(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deny(reason: string): Decision {
  return { allowed: false, reason };
}
