# Vengtoo MCP Gateway

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node-≥18-339933.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/@vengtoo/mcp-gateway)](https://www.npmjs.com/package/@vengtoo/mcp-gateway)

**Authorization gateway for AI agents and MCP tool calls.**

> Open-source. Drop-in. Works with any MCP client.

## Why

AI agents connected to MCP servers can call any tool they have access to: read your database, delete files, execute arbitrary SQL. Vengtoo MCP Gateway puts a policy enforcement point between the agent and those tools, so every call is authorized before it executes.

## What it does

- Sits between MCP clients (Claude Code, Cursor, VS Code, GitHub Copilot) and any MCP server
- Intercepts every tool call and checks authorization before forwarding
- Two modes: **cloud** (Vengtoo Cloud API) and **local** (Vengtoo Agent + .rego policy file)
- Full audit trail of every tool invocation: subject, tool name, arguments, and decision are logged as structured JSON:

```json
{"ts":"2026-05-25T10:03:11.482Z","level":"info","msg":"mcp_tool_call","subject":"agent:ai-assistant","tool":"database__query","allowed":true,"latency_ms":0.8}
```

## Quick Start

1. Install and start the [Vengtoo Agent](https://github.com/vengtoo/agent). The agent runs locally and evaluates your authorization policy; no cloud account needed.

```bash
go install github.com/vengtoo/agent/cmd/agent@latest
vengtoo-agent --policy ./policy.rego
```

Create a `policy.rego` to define what your agent can do:

```rego
package vengtoo.mcp

default allow := false

# Allow read-only tools
allow if { input.resource.name == "database__query" }
allow if { input.resource.name == "database__list_tables" }

# Allow writes, but block destructive SQL
allow if {
    input.resource.name == "database__execute"
    not contains(lower(input.resource.attributes.sql), "drop")
    not contains(lower(input.resource.attributes.sql), "delete from")
}
```

See [`demo/policies/`](demo/policies/) for more examples including Kubernetes namespace protection.

2. Create a `gateway.config.json`:

```json
{
  "vengtoo": {
    "agentUrl": "http://127.0.0.1:8181"
  },
  "subject": "agent:ai-assistant",
  "servers": {
    "database": {
      "command": "node",
      "args": ["./my-database-mcp-server.js"]
    }
  }
}
```

3. Add to your MCP client (e.g. Claude Code):

```bash
claude mcp add --transport stdio vengtoo-gateway -- \
  npx vengtoo-mcp-gateway --config /path/to/gateway.config.json
```

## Configuration

### Config schema

| Field              | Type   | Required | Description                                                    |
| ------------------ | ------ | -------- | -------------------------------------------------------------- |
| `vengtoo.agentUrl`  | string | \*       | URL of local Vengtoo Agent (local mode)                         |
| `vengtoo.cloudUrl`  | string | \*       | URL of Vengtoo Cloud API (cloud mode)                           |
| `vengtoo.apiKey`    | string |          | API key from [Vengtoo Cloud](https://console.vengtoo.com) (or set `VENGTOO_API_KEY` env var) |
| `vengtoo.timeoutMs` | number |          | Authorization request timeout (default: 5000)                  |
| `subject`          | string | yes      | Identity of the agent making tool calls                        |
| `subjectType`      | string |          | Subject type (default: `"agent"`)                              |
| `resourceType`     | string |          | Resource type for authorization checks (default: `"mcp_tool"`) |
| `servers`          | object | yes      | Map of downstream MCP servers to proxy                         |
| `transport`        | string |          | Caller transport: `"stdio"` (default) or `"http"`, see [Transport](#transport) |
| `http`             | object |          | HTTP transport settings (used when `transport` is `"http"`)    |

\* Provide either `agentUrl` (local mode) or `cloudUrl` (cloud mode).

Each entry in `servers` has:

| Field     | Type     | Required | Description                      |
| --------- | -------- | -------- | -------------------------------- |
| `command` | string   | yes      | Command to spawn the MCP server  |
| `args`    | string[] |          | Command arguments                |
| `env`     | object   |          | Additional environment variables |

## Modes

### Cloud mode

Connect to Vengtoo Cloud for managed policies:

```json
{
  "vengtoo": {
    "cloudUrl": "https://api.vengtoo.com/access/v1/evaluation",
    "apiKey": "vgt_..."
  },
  "subject": "agent:prod-assistant",
  "servers": {
    "database": {
      "command": "node",
      "args": ["./db-server.js"]
    }
  }
}
```

### Local mode

Run the Vengtoo Agent locally with a .rego policy file for offline, self-contained authorization:

```bash
# Start the agent with your policy
vengtoo-agent --policy ./policy.rego
```

```json
{
  "vengtoo": {
    "agentUrl": "http://127.0.0.1:8181"
  },
  "subject": "agent:dev-assistant",
  "servers": {
    "database": {
      "command": "node",
      "args": ["./db-server.js"]
    }
  }
}
```

## Transport

The gateway exposes its (policy-enforced) tools to callers over one of two transports.

### stdio (default)

Runs as a local subprocess speaking MCP over stdin/stdout: the right choice for a
single desktop agent (Claude Desktop, Cursor, Claude Code). No network surface.

### HTTP (remote)

Runs a [Streamable HTTP](https://modelcontextprotocol.io/) MCP server at a URL, so a
remote agent (or many concurrent agents) can share one governed gateway. Enable it
with `--http` (or `"transport": "http"` in the config):

```bash
vengtoo-mcp-gateway --config gateway.config.json --http --port 8808
```

```json
{
  "vengtoo": { "cloudUrl": "https://api.vengtoo.com/access/v1/evaluation", "apiKey": "vgt_..." },
  "subject": "agent:prod-assistant",
  "transport": "http",
  "http": {
    "port": 8808,
    "host": "0.0.0.0",
    "path": "/mcp",
    "authTokens": ["<caller-token>"],
    "allowedHosts": ["gateway.example.com"]
  },
  "servers": { "database": { "command": "node", "args": ["./db-server.js"] } }
}
```

HTTP config (`http.*`):

| Field           | Type     | Default       | Description                                                                 |
| --------------- | -------- | ------------- | --------------------------------------------------------------------------- |
| `port`          | number   | `8808`        | TCP port to listen on                                                       |
| `host`          | string   | `127.0.0.1`   | Interface to bind; `0.0.0.0` accepts remote connections                     |
| `path`          | string   | `/mcp`        | URL path of the MCP endpoint                                                |
| `callers`       | object[] | -             | Per-caller identity: `{ "token": "...", "subject": "agent:claude" }`; each bearer token authorizes as its own subject |
| `authTokens`    | string[] | -             | Anonymous bearer tokens; grant access, run as the global `subject`         |
| `allowedHosts`  | string[] | -             | Enables DNS-rebinding protection; rejects requests with an unlisted `Host`  |
| `allowedOrigins`| string[] | -             | Enables DNS-rebinding protection; rejects requests with an unlisted `Origin`|

**Per-caller identity.** Give each agent its own token and subject, and your policies
(and audit trail) see each caller's real identity through one shared gateway:

```json
"http": {
  "port": 8808,
  "callers": [
    { "token": "<claude-token>", "subject": "agent:claude" },
    { "token": "<cursor-token>", "subject": "agent:cursor" }
  ]
}
```

Also settable via `VENGTOO_GATEWAY_HTTP_CALLERS="<token>=agent:claude,<token>=agent:cursor"`.
Sessions are bound to the token that opened them: a different caller presenting another
caller's session id gets a 401, so identities cannot cross sessions. Tokens listed in
`authTokens` (or callers omitted entirely) run as the config's global `subject`.

**Safety:** the gateway **refuses to bind a non-loopback interface with no caller auth**
(`callers` or `authTokens`). Either configure tokens, or set
`VENGTOO_GATEWAY_ALLOW_UNAUTHENTICATED=true` to knowingly expose an open endpoint. An
unauthenticated `GET /healthz` liveness probe is always served.

> ⚠️ **Security: Vengtoo trusts whichever subject this gateway asserts.** The
> `callers` token→subject mapping above (owned by this gateway's own config) is the
> correct pattern; it is NOT the same as trusting a client-supplied header. Never
> change this to derive the subject from a header/field a calling client sends; that
> would let any caller claim to be any subject and inherit its permissions within
> your tenant. If you front this gateway with another reverse proxy, make sure that
> proxy cannot be made to forward an arbitrary caller-chosen bearer token or subject.

## CLI Flags

| Flag                       | Description                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `--config <path>`          | Path to gateway config file (default: `./gateway.config.json`)                         |
| `--http`                   | Serve over HTTP instead of stdio                                                       |
| `--port <n>`               | HTTP listen port (default: `8808`; implies `--http`-compatible config)                |
| `--host <h>`               | HTTP bind interface (default: `127.0.0.1`)                                             |
| `--path <p>`               | HTTP endpoint path (default: `/mcp`)                                                   |
| `--list-tools`             | List all tools from configured downstream servers and exit                             |
| `--generate-policy [path]` | Generate a starter .rego policy file for the configured tools (default: `policy.rego`) |

Environment overrides: `VENGTOO_API_KEY`, `VENGTOO_AGENT_URL`, `VENGTOO_SUBJECT`,
`VENGTOO_GATEWAY_TRANSPORT` (`http`), `VENGTOO_GATEWAY_PORT` / `PORT`, `VENGTOO_GATEWAY_HOST`,
`VENGTOO_GATEWAY_PATH`, `VENGTOO_GATEWAY_HTTP_TOKENS` (comma-separated), `VENGTOO_GATEWAY_ALLOW_UNAUTHENTICATED`.

## MCP Client Setup

The gateway runs as a stdio MCP server. Point your MCP client at it instead of the downstream server directly.

### Claude Code

```bash
claude mcp add --transport stdio vengtoo-gateway -- \
  npx vengtoo-mcp-gateway --config /path/to/gateway.config.json
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "vengtoo-gateway": {
      "command": "npx",
      "args": ["vengtoo-mcp-gateway", "--config", "/path/to/gateway.config.json"]
    }
  }
}
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "vengtoo-gateway": {
      "command": "npx",
      "args": ["vengtoo-mcp-gateway", "--config", "/path/to/gateway.config.json"]
    }
  }
}
```

### VS Code / GitHub Copilot

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "vengtoo-gateway": {
      "type": "stdio",
      "command": "npx",
      "args": ["vengtoo-mcp-gateway", "--config", "/path/to/gateway.config.json"]
    }
  }
}
```

See [`demo/`](demo/) for full end-to-end examples with sample policies.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for what's planned: per-caller OAuth, downstream
resilience, dynamic tool lists, metrics, remote downstream servers, and more.

## Feedback

- [GitHub Issues](https://github.com/vengtoo/mcp-gateway/issues): Bug reports and feature requests
- [Documentation](https://docs.vengtoo.com): Guides and API reference

## License

Apache-2.0, see [LICENSE](LICENSE).
