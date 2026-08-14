# Vengtoo MCP Gateway — Demo

Two real-world AI agent incidents, recreated and prevented.

## Quick Start

### Prerequisites

- Node.js >= 18
- [Vengtoo Agent](https://github.com/vengtoo/agent) installed

### Run the Database Demo

```bash
# Terminal 1: Start the Vengtoo Agent with the database policy
vengtoo-agent --policy ./demo/policies/mcp-database-policy.rego

# Terminal 2: Install dependencies and run the end-to-end test
npm install && npm run build
node demo/e2e-test.mjs
```

### Run with an MCP Client

1. Start the agent with a policy:

```bash
vengtoo-agent --policy ./demo/policies/mcp-database-policy.rego
```

2. Add the gateway to your MCP client (e.g. Claude Code):

```bash
claude mcp add --transport stdio vengtoo-database -- \
  npx vengtoo-mcp-gateway --config ./demo/demo-database.config.json
```

Now try asking your AI assistant to "drop the users table" — the gateway will block it.

## Incident 1: AI Agent Deletes Production Database

An AI coding assistant, given database access via MCP, executes `DROP TABLE users` — wiping production data.

**Without Vengtoo:** The command executes. Users table is gone. Recovery takes hours.

**With Vengtoo:** The gateway intercepts the tool call, checks policy, and blocks the `DROP` before it reaches the database.

**What happens:**

1. `database__list_tables` → ALLOWED (read-only, safe)
2. `database__query` with `SELECT * FROM users` → ALLOWED
3. `database__execute` with `INSERT INTO users ...` → ALLOWED (safe write)
4. `database__execute` with `DROP TABLE users` → **DENIED** by Vengtoo policy

## Incident 2: DevOps Agent Wipes EKS Production

A DevOps engineer runs a cleanup script through an AI agent. It deletes the production namespace — taking down all services.

**Without Vengtoo:** `kubectl delete namespace production` runs. All pods, services, deployments — gone.

**With Vengtoo:** The gateway blocks any `delete_resource` targeting the production namespace.

**What happens:**

1. `kubernetes__get_pods` in production → ALLOWED (read-only)
2. `kubernetes__delete_resource` (pod in staging) → ALLOWED (non-prod)
3. `kubernetes__delete_resource` (namespace: production) → **DENIED**
4. `kubernetes__scale_deployment` to 0 in production → **DENIED**

## Policies

| File                         | What it does                                                                                   |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `mcp-database-policy.rego`   | Blocks DROP, TRUNCATE, DELETE, ALTER TABLE — allows reads and safe writes                      |
| `mcp-kubernetes-policy.rego` | Blocks destructive ops on production namespace — allows reads everywhere and writes to staging |

## Key Points

- **Zero code changes** — the gateway is a config-only proxy. Drop it in front of any MCP server.
- **Fail-closed** — if the Vengtoo Agent is unreachable, every tool call is denied.
- **Auditable** — every allow/deny decision is logged with subject, tool, arguments, and reason.
- **Policy as code** — in local mode, guardrails are `.rego` files you version-control alongside your code.

## Cloud Mode

For managed policies without local `.rego` files, try [Vengtoo Cloud](https://console.vengtoo.com). Create policies in the dashboard, and point the gateway at the cloud API instead of a local agent:

```json
{
  "vengtoo": {
    "cloudUrl": "https://api.vengtoo.com/access/v1/evaluation",
    "apiKey": "vgt_..."
  },
  "subject": "agent:ai-assistant",
  "servers": { ... }
}
```
