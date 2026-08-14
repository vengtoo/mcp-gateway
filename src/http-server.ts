import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { GatewayConfig, HttpCaller } from "./types";
import type { GatewayContext } from "./gateway";
import { createConfiguredServer } from "./gateway";

const DEFAULT_PORT = 8808;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PATH = "/mcp";

// Public-listener hardening knobs. Deliberately conservative: MCP payloads are
// small and sessions are cheap, so the caps exist to bound a hostile client's
// blast radius, not to constrain legitimate use.
const MAX_BODY_BYTES = 4 * 1024 * 1024;        // reject oversized JSON bodies
const MAX_SESSIONS = 2_000;                    // ceiling on concurrent sessions
const SESSION_IDLE_MS = 10 * 60_000;           // evict sessions idle this long
const REAPER_INTERVAL_MS = 60_000;             // idle-sweep cadence
const HEADERS_TIMEOUT_MS = 20_000;             // slowloris: cap time to send headers
const REQUEST_TIMEOUT_MS = 120_000;            // cap total time to send a request
const KEEPALIVE_TIMEOUT_MS = 30_000;           // idle keep-alive socket timeout
const MAX_CONNECTIONS = 10_000;                // socket-level backstop
const SHUTDOWN_GRACE_MS = 10_000;              // drain window before forcing sockets closed

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface HttpOptions {
  port: number;
  host: string;
  path: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  /** Identified callers: token → subject. Preferred over authTokens. */
  callers?: HttpCaller[];
  /** Anonymous tokens: grant access, run as the config's global subject. */
  authTokens?: string[];
  /** Explicit escape hatch to bind a public interface with no caller auth.
   *  Off by default so we fail closed instead of silently exposing an open MCP
   *  endpoint. Set via VENGTOO_GATEWAY_ALLOW_UNAUTHENTICATED=true. */
  allowUnauthenticated?: boolean;
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  lastActivity: number;
  /** Subject this session's calls are authorized/audited as (undefined =
   *  the config's global subject). Fixed at initialize time. */
  subject?: string;
  /** Token that opened the session. Every follow-up request must present the
   *  same token — otherwise a second valid caller could attach to this session
   *  id and inherit the first caller's identity. */
  token?: string;
}

/** Outcome of the bearer check: whether the request may proceed, which token
 *  it presented, and the subject that token maps to (if identified). */
interface AuthResult {
  ok: boolean;
  token?: string;
  subject?: string;
}

/**
 * Resolves the effective HTTP options from config + environment. Flag/file
 * precedence is applied upstream in the CLI; this fills defaults and folds in
 * the environment-only overrides (tokens, unauthenticated escape hatch).
 */
export function resolveHttpOptions(config: GatewayConfig): HttpOptions {
  const http = config.http ?? {};
  const envTokens = splitCsv(process.env.VENGTOO_GATEWAY_HTTP_TOKENS);
  const envCallers = parseCallersEnv(process.env.VENGTOO_GATEWAY_HTTP_CALLERS);
  return {
    port: http.port ?? DEFAULT_PORT,
    host: http.host ?? DEFAULT_HOST,
    path: normalizePath(http.path ?? DEFAULT_PATH),
    allowedHosts: http.allowedHosts,
    allowedOrigins: http.allowedOrigins,
    callers: envCallers.length > 0 ? envCallers : http.callers,
    authTokens: envTokens.length > 0 ? envTokens : http.authTokens,
    allowUnauthenticated: process.env.VENGTOO_GATEWAY_ALLOW_UNAUTHENTICATED === "true",
  };
}

/** Parses VENGTOO_GATEWAY_HTTP_CALLERS: "token=subject,token=subject".
 *  ("=" as the pair separator because subjects conventionally contain ":",
 *  e.g. "agent:claude".) Malformed entries are skipped with a warning. */
function parseCallersEnv(v: string | undefined): HttpCaller[] {
  const callers: HttpCaller[] = [];
  for (const entry of splitCsv(v)) {
    const eq = entry.indexOf("=");
    const token = eq > 0 ? entry.slice(0, eq).trim() : "";
    const subject = eq > 0 ? entry.slice(eq + 1).trim() : "";
    if (!token || !subject) {
      console.error(
        `[vengtoo-gateway] ignoring malformed VENGTOO_GATEWAY_HTTP_CALLERS entry (want token=subject): "${entry}"`
      );
      continue;
    }
    callers.push({ token, subject });
  }
  return callers;
}

/**
 * Starts a Streamable-HTTP MCP server in front of the shared gateway context.
 *
 * Stateful: the first POST (an `initialize`) mints a session id returned in
 * `mcp-session-id`, which every follow-up carries. Each session owns its own MCP
 * `Server`, but all sessions share the one downstream fleet and block set in
 * `ctx`, so a block/deny decision holds regardless of which session calls. GET
 * opens the server→client SSE stream (used later for HITL push); DELETE ends a
 * session.
 *
 * Hardened for public exposure: bounded body size, bounded + idle-evicted
 * session table, slowloris timeouts, timing-safe bearer check, and a fail-closed
 * refusal to bind a non-loopback interface without caller auth.
 *
 * Resolves to a shutdown function that drains sessions and closes the listener.
 */
export function startHttpServer(
  ctx: GatewayContext,
  opts: HttpOptions
): Promise<() => Promise<void>> {
  assertSafeToBind(opts);

  const sessions = new Map<string, Session>();

  const httpServer = createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error("[vengtoo-gateway] http handler error:", err instanceof Error ? err.message : err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(jsonRpcError(null, -32603, "Internal server error"));
      } else {
        res.end();
      }
    });
  });

  hardenServer(httpServer);

  const reaper = setInterval(() => reapIdleSessions(sessions), REAPER_INTERVAL_MS);
  reaper.unref(); // don't keep the process alive on the reaper alone

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    // Health check — unauthenticated so probes/load balancers can reach it, but
    // it reveals nothing beyond liveness and the live-session count.
    if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/health")) {
      writeJson(res, 200, { status: "ok", sessions: sessions.size });
      return;
    }

    if (url.pathname !== opts.path) {
      writeJson(res, 404, { error: "not found" });
      return;
    }

    const auth = authenticate(req, opts);
    if (!auth.ok) {
      res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
      res.end(jsonRpcError(null, -32001, "Unauthorized: missing or invalid bearer token"));
      return;
    }

    const sessionId = headerValue(req.headers["mcp-session-id"]);

    if (req.method === "POST") {
      const body = await readJsonBody(req, res);
      if (body === undefined) return; // readJsonBody already responded

      let session = sessionId ? sessions.get(sessionId) : undefined;
      if (session && !sessionTokenMatches(session, auth)) {
        // A *different* valid caller is presenting this session id. Refusing
        // (rather than proceeding) is what stops caller B from inheriting
        // caller A's subject.
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(jsonRpcError(null, -32001, "Unauthorized: token does not match this session"));
        return;
      }
      if (!session) {
        if (!isInitializeRequest(body)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            jsonRpcError(null, -32000, "Bad Request: no valid session ID for a non-initialize request")
          );
          return;
        }
        session = tryOpenSession(res, auth);
        if (!session) return; // at capacity — tryOpenSession already responded
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === "GET" || req.method === "DELETE") {
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (!session) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(jsonRpcError(null, -32000, "Bad Request: invalid or missing session ID"));
        return;
      }
      if (!sessionTokenMatches(session, auth)) {
        res.writeHead(401, { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" });
        res.end(jsonRpcError(null, -32001, "Unauthorized: token does not match this session"));
        return;
      }
      session.lastActivity = Date.now();
      await session.transport.handleRequest(req, res);
      return;
    }

    res.writeHead(405, { Allow: "GET, POST, DELETE", "Content-Type": "application/json" });
    res.end(jsonRpcError(null, -32000, `Method ${req.method} not allowed`));
  }

  /** Creates a session, enforcing the concurrency ceiling. Responds with 503 and
   *  returns undefined when the table is full even after reaping idle entries. */
  function tryOpenSession(res: ServerResponse, auth: AuthResult): Session | undefined {
    if (sessions.size >= MAX_SESSIONS) {
      reapIdleSessions(sessions);
      if (sessions.size >= MAX_SESSIONS) {
        console.error(`[vengtoo-gateway] refusing new session — at capacity (${MAX_SESSIONS})`);
        res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "30" });
        res.end(jsonRpcError(null, -32000, "Server at capacity — try again shortly"));
        return undefined;
      }
    }
    return openSession(auth);
  }

  function openSession(auth: AuthResult): Session {
    const dnsProtection =
      opts.allowedHosts?.length || opts.allowedOrigins?.length
        ? {
            enableDnsRebindingProtection: true,
            allowedHosts: opts.allowedHosts,
            allowedOrigins: opts.allowedOrigins,
          }
        : {};

    // The session's server authorizes/audits as the caller's mapped subject;
    // anonymous tokens (or open mode) fall back to the config's global subject.
    const server = createConfiguredServer(ctx, auth.subject);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        session.lastActivity = Date.now();
        sessions.set(id, session);
        console.error(
          `[vengtoo-gateway] session opened: ${id} as ${auth.subject ?? ctx.config.subject} (${sessions.size} live)`
        );
      },
      ...dnsProtection,
    });

    const session: Session = {
      transport,
      server,
      lastActivity: Date.now(),
      subject: auth.subject,
      token: auth.token,
    };

    transport.onclose = () => {
      const id = transport.sessionId;
      if (id && sessions.delete(id)) {
        console.error(`[vengtoo-gateway] session closed: ${id} (${sessions.size} live)`);
      }
    };

    // Wire the pipe now; the transport buffers until handleRequest drives it.
    void server.connect(transport).catch((err) =>
      console.error("[vengtoo-gateway] session connect error:", err instanceof Error ? err.message : err)
    );

    return session;
  }

  return new Promise((resolve, reject) => {
    const onListenError = (err: Error) => reject(err);
    httpServer.on("error", onListenError);
    httpServer.listen(opts.port, opts.host, () => {
      httpServer.off("error", onListenError);
      // Past startup, connection errors must not crash the process.
      httpServer.on("error", (err) =>
        console.error("[vengtoo-gateway] http server error:", err instanceof Error ? err.message : err)
      );
      const callerCount = opts.callers?.length ?? 0;
      const tokenCount = opts.authTokens?.length ?? 0;
      const gate =
        callerCount + tokenCount > 0
          ? `${callerCount} identified caller(s), ${tokenCount} anonymous token(s)`
          : "OPEN (loopback / explicitly allowed)";
      console.error(
        `[vengtoo-gateway] HTTP listening on http://${opts.host}:${opts.port}${opts.path} (${gate})`
      );
      resolve(() => shutdown(httpServer, sessions, reaper));
    });
  });
}

/** Fail-closed guard: refuse to expose a non-loopback interface with no caller
 *  auth unless the operator explicitly opts in. Prevents an accidental open
 *  public MCP endpoint. */
function assertSafeToBind(opts: HttpOptions): void {
  const isLoopback = LOOPBACK_HOSTS.has(opts.host);
  const hasAuth = (opts.authTokens?.length ?? 0) > 0 || (opts.callers?.length ?? 0) > 0;
  if (!isLoopback && !hasAuth && !opts.allowUnauthenticated) {
    throw new Error(
      `refusing to bind ${opts.host}:${opts.port} with no caller auth. ` +
        `Set http.callers / http.authTokens (or VENGTOO_GATEWAY_HTTP_CALLERS / ` +
        `VENGTOO_GATEWAY_HTTP_TOKENS), or explicitly set ` +
        `VENGTOO_GATEWAY_ALLOW_UNAUTHENTICATED=true to expose an open endpoint.`
    );
  }
}

function hardenServer(httpServer: HttpServer): void {
  httpServer.headersTimeout = HEADERS_TIMEOUT_MS;
  httpServer.requestTimeout = REQUEST_TIMEOUT_MS;
  httpServer.keepAliveTimeout = KEEPALIVE_TIMEOUT_MS;
  httpServer.maxConnections = MAX_CONNECTIONS;
}

function reapIdleSessions(sessions: Map<string, Session>): void {
  const cutoff = Date.now() - SESSION_IDLE_MS;
  for (const [id, session] of sessions) {
    if (session.lastActivity < cutoff) {
      console.error(`[vengtoo-gateway] reaping idle session: ${id}`);
      // close() fires onclose, which removes it from the map.
      void session.transport.close().catch(() => sessions.delete(id));
    }
  }
}

async function shutdown(
  httpServer: HttpServer,
  sessions: Map<string, Session>,
  reaper: ReturnType<typeof setInterval>
): Promise<void> {
  clearInterval(reaper);
  for (const { transport } of sessions.values()) {
    try { await transport.close(); } catch { /* best effort */ }
  }
  sessions.clear();
  await new Promise<void>((resolve) => {
    const forced = setTimeout(() => {
      // Keep-alive sockets can outlive close(); force them after the grace window.
      httpServer.closeAllConnections?.();
    }, SHUTDOWN_GRACE_MS);
    forced.unref();
    httpServer.close(() => {
      clearTimeout(forced);
      resolve();
    });
    httpServer.closeIdleConnections?.();
  });
}

function authenticate(req: IncomingMessage, opts: HttpOptions): AuthResult {
  const hasCallers = (opts.callers?.length ?? 0) > 0;
  const hasTokens = (opts.authTokens?.length ?? 0) > 0;
  if (!hasCallers && !hasTokens) return { ok: true }; // open (loopback/allowed)

  const header = headerValue(req.headers["authorization"]);
  if (!header) return { ok: false };
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return { ok: false };
  const presented = match[1].trim();

  // Constant-time compare against every configured token — no early exit — so
  // a rejected request leaks nothing about which/how-many tokens exist via
  // response timing.
  let ok = false;
  let subject: string | undefined;
  for (const caller of opts.callers ?? []) {
    if (constantTimeEqual(presented, caller.token)) {
      ok = true;
      subject = caller.subject;
    }
  }
  for (const token of opts.authTokens ?? []) {
    if (constantTimeEqual(presented, token)) ok = true;
  }
  return ok ? { ok, token: presented, subject } : { ok: false };
}

/** A request may only touch a session with the token that opened it. Sessions
 *  opened in open mode (no tokens configured) have no binding. */
function sessionTokenMatches(session: Session, auth: AuthResult): boolean {
  if (session.token === undefined && auth.token === undefined) return true;
  if (session.token === undefined || auth.token === undefined) return false;
  return constantTimeEqual(session.token, auth.token);
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false; // length is not secret
  return timingSafeEqual(ab, bb);
}

/** Reads and JSON-parses a request body, responding directly on error. Returns
 *  `undefined` when it has already written an error response. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_BODY_BYTES) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(jsonRpcError(null, -32000, "Payload too large"));
        req.destroy();
        return undefined;
      }
      chunks.push(chunk as Buffer);
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(jsonRpcError(null, -32000, "Bad Request: error reading body"));
    }
    return undefined;
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return {}; // empty POST — let the transport reject it as non-initialize
  try {
    return JSON.parse(raw);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(jsonRpcError(null, -32700, "Parse error: body is not valid JSON"));
    return undefined;
  }
}

function splitCsv(v: string | undefined): string[] {
  return (v ?? "").split(",").map((t) => t.trim()).filter(Boolean);
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function normalizePath(p: string): string {
  const trimmed = p.startsWith("/") ? p : `/${p}`;
  return trimmed.length > 1 && trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function jsonRpcError(id: string | number | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id });
}
