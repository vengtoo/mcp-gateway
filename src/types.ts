export interface GatewayConfig {
  vengtoo: {
    agentUrl?: string;
    cloudUrl?: string;
    apiKey?: string;
    clientId?: string;
    clientSecret?: string;
    timeoutMs?: number;
    blockOnDrift?: boolean;
    // Max time (ms) a tool call blocks while awaiting human approval (HITL)
    // before returning "still pending". Default 50000. Keep it under your MCP
    // client's request timeout; the agent can re-invoke to resume waiting.
    approvalMaxWaitMs?: number;
    // tools/list filtering: when true, tools/list returns only the tools the
    // caller's subject may INVOKE (tool-LEVEL; argument-level conditions can't be
    // evaluated at list time and stay enforced at call time). Default false.
    // Overridable via MCP_FILTER_TOOLS_LIST=true.
    filterToolsList?: boolean;
    // When a tools/list authz call fails, hide all tools (fail CLOSED) instead of
    // returning the unfiltered list. Default false (fail OPEN) — call-time
    // ext-authz still blocks unauthorized invocations, so a transient authz blip
    // shouldn't blank the agent's whole toolset. Override: MCP_FILTER_TOOLS_LIST_FAIL_CLOSED.
    filterToolsListFailClosed?: boolean;
  };
  subject: string;
  subjectType?: string;
  resourceType?: string;
  servers: Record<string, ServerConfig>;
  // NOTE: the gateway does not forward audit to the cloud — tool-call records are
  // logged to stderr only. Every decision is a cloud/agent eval call, so the
  // canonical record already lives in the cloud's Decision Log. See AuditLog.
  // Which server transport the gateway exposes to callers. "stdio" (default)
  // runs as a local subprocess speaking MCP over stdin/stdout. "http" runs a
  // remote Streamable-HTTP server at a URL — see `http` below.
  transport?: "stdio" | "http";
  http?: HttpConfig;
}

export interface HttpConfig {
  // TCP port to listen on. Default 8808.
  port?: number;
  // Interface to bind. Default "127.0.0.1" (localhost only). Set "0.0.0.0" to
  // accept remote connections (e.g. inside a container behind a proxy).
  host?: string;
  // URL path the MCP endpoint is served at. Default "/mcp".
  path?: string;
  // DNS-rebinding protection. When either list is non-empty the transport
  // rejects requests whose Host/Origin isn't listed. Leave unset for local dev.
  allowedHosts?: string[];
  allowedOrigins?: string[];
  // Per-caller identity: each entry maps a bearer token to the subject that
  // caller's tool calls are authorized and audited as. This is how two agents
  // sharing one gateway get different permissions. Overridable via
  // VENGTOO_GATEWAY_HTTP_CALLERS ("token=subject,token=subject").
  callers?: HttpCaller[];
  // Anonymous caller gate: tokens that grant access but carry no identity —
  // requests authenticated this way run as the config's global `subject`.
  // Prefer `callers`. Off (open) when both lists are empty — never leave a
  // public URL open. Overridable via VENGTOO_GATEWAY_HTTP_TOKENS (comma-separated).
  authTokens?: string[];
}

export interface HttpCaller {
  token: string;
  // Subject this token authorizes as (e.g. "agent:claude"). Free-form; must
  // match the subject your Vengtoo policies reference.
  subject: string;
}

export interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AuthorizeResult {
  allowed: boolean;
  reason?: string;
}

export type DriftChangeType =
  | "tool_removed"
  | "tool_added"
  | "parameter_removed"
  | "parameter_added"
  | "type_changed"
  | "description_changed"
  // Catch-all: the serialized schema differs but none of the specific
  // comparisons above fired (e.g. a nested parameter-description edit — the
  // classic MCP rug-pull vector). Guarantees any byte-level schema change
  // yields at least one event, so blockOnDrift can never be bypassed by a
  // change the field-level diff doesn't model.
  | "schema_changed";

// A single observed change to a tool's schema — raw facts only. Severity is
// deliberately absent: the cloud scores it from these facts (see drift.ts).
export interface DriftEvent {
  toolName: string;
  serverName: string;
  changeType: DriftChangeType;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  message: string;
}

export interface ToolSnapshot {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface ServerSnapshot {
  server: string;
  hash: string;
  tools: ToolSnapshot[];
  capturedAt: string;
}
