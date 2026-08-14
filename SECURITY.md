# Security Policy

## Reporting a Vulnerability

Please **do not** open a public issue for security vulnerabilities.

Report them privately to **security@vengtoo.com**. Include:

- A description of the issue and its impact
- Steps to reproduce (a minimal gateway config / MCP interaction is ideal)
- The gateway version or commit hash

We will acknowledge your report within 3 business days and keep you updated as
we work on a fix. We ask that you give us a reasonable window to release a
patch before public disclosure, and we will credit you in the release notes
unless you prefer otherwise.

## Scope

The gateway is the policy-enforcement point between AI agents and MCP tool
servers, so we treat these classes of issues as high severity:

- **Enforcement bypass** — any way for a tool call to reach a downstream
  server without an allow decision: policy denies, drift blocks, and
  pending-review holds must all be unbypassable, and infra failures must deny
  (fail closed), never allow.
- **Drift-detection evasion** — a change to a downstream tool's schema or
  descriptions (including nested fields — the "rug pull" vector) that does not
  surface as a drift event or hash change.
- **Credential exposure** — the gateway's API key or HTTP bearer tokens
  reaching a downstream server process, a log line, or an audit record.
- **HTTP listener auth bypass** — reaching the MCP endpoint without a valid
  bearer token when tokens are configured, or tricking the gateway into
  binding a public interface unauthenticated.

Denial-of-service against the gateway's own HTTP listener, and issues that
require control of the gateway's host or config file, are generally lower
severity but still welcome reports.

## Hardening Recommendations

- Keep the gateway on `127.0.0.1` (the default) unless remote callers need it;
  when exposing it, always set `http.authTokens` (or
  `VENGTOO_GATEWAY_HTTP_TOKENS`) and `allowedHosts`/`allowedOrigins`.
- Pass the API key via `VENGTOO_API_KEY` rather than the config file when the
  config is checked into a repo.
- In HTTP mode, prefer `http.callers` (token → subject) over `http.authTokens`
  so each agent is authorized and audited as its own identity; anonymous
  tokens all run as the config's global `subject`.
- Treat downstream MCP servers as untrusted: the gateway strips its own
  credentials from their environment, but anything you add under a server's
  `env` is visible to that server.

## Supported Versions

Security fixes are applied to the latest minor release. Older releases
receive fixes on a best-effort basis.
