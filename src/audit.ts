import { randomUUID } from "crypto";

interface ToolCallRecord {
  requestId: string;
  subject: string;
  tool: string;
  args: Record<string, unknown>;
  allowed: boolean;
  reason?: string;
  latencyMs: number;
  timestamp: string;
}

/**
 * Local, structured audit logging to stderr.
 *
 * The gateway deliberately does NOT forward audit to the cloud. Every policy
 * decision the gateway makes is a cloud (or local-agent) eval call, so the
 * decision is already recorded upstream — the cloud's Decision Log. Forwarding
 * from here would only duplicate that (and the gateway is never the sole witness
 * of a decision, unlike the offline-capable agent). Operators who want these
 * lines in their own tooling ship stderr through their normal log pipeline; the
 * canonical, queryable record lives in the cloud.
 */
export class AuditLog {
  record(rec: ToolCallRecord): void {
    const entry = {
      ts: rec.timestamp,
      level: rec.allowed ? "info" : "warn",
      msg: "mcp_tool_call",
      subject: rec.subject,
      tool: rec.tool,
      allowed: rec.allowed,
      reason: rec.reason,
      latency_ms: rec.latencyMs,
      request_id: rec.requestId,
    };
    console.error(JSON.stringify(entry));
  }
}

export function generateRequestId(): string {
  return randomUUID();
}
