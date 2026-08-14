#!/usr/bin/env node

/**
 * Mock Database MCP Server — simulates a Postgres MCP server for demo purposes.
 * Implements MCP protocol over stdio with realistic database tools.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const TOOLS = [
  {
    name: "query",
    description: "Execute a read-only SQL query against the database",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL query to execute" },
      },
      required: ["sql"],
    },
  },
  {
    name: "execute",
    description: "Execute a write SQL statement (INSERT, UPDATE, DELETE, DROP, ALTER, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement to execute" },
      },
      required: ["sql"],
    },
  },
  {
    name: "list_tables",
    description: "List all tables in the database",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "describe_table",
    description: "Show the schema of a table",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name" },
      },
      required: ["table"],
    },
  },
];

const MOCK_TABLES = {
  users: [
    { id: 1, email: "alice@acme.com", role: "admin", created_at: "2025-01-15" },
    { id: 2, email: "bob@acme.com", role: "engineer", created_at: "2025-02-20" },
    { id: 3, email: "carol@acme.com", role: "finance", created_at: "2025-03-10" },
  ],
  orders: [
    { id: 101, user_id: 1, amount: 2500.0, status: "completed" },
    { id: 102, user_id: 2, amount: 180.5, status: "pending" },
    { id: 103, user_id: 3, amount: 47200.0, status: "completed" },
  ],
  payments: [
    { id: 201, order_id: 101, amount: 2500.0, method: "stripe", processed_at: "2025-01-16" },
    { id: 202, order_id: 103, amount: 47200.0, method: "wire", processed_at: "2025-03-12" },
  ],
};

const MOCK_SCHEMAS = {
  users: "id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, role VARCHAR(50), created_at TIMESTAMP",
  orders: "id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), amount DECIMAL(10,2), status VARCHAR(20)",
  payments: "id SERIAL PRIMARY KEY, order_id INT REFERENCES orders(id), amount DECIMAL(10,2), method VARCHAR(50), processed_at TIMESTAMP",
};

function handleTool(name, args) {
  // Test marker: proves whether a call actually reached the downstream server.
  // Denied/pending/blocked tool calls must NEVER produce this line.
  process.stderr.write(`[DOWNSTREAM-RECEIVED] tool=${name} args=${JSON.stringify(args)}\n`);
  switch (name) {
    case "list_tables":
      return formatResult(Object.keys(MOCK_TABLES).map((t) => ({ table_name: t })));

    case "describe_table": {
      const schema = MOCK_SCHEMAS[args.table];
      if (!schema) return errorResult(`Table '${args.table}' not found`);
      return formatResult({ table: args.table, columns: schema });
    }

    case "query": {
      const sql = (args.sql || "").toLowerCase().trim();
      if (sql.includes("drop") || sql.includes("delete") || sql.includes("truncate") || sql.includes("alter")) {
        return errorResult("Use the 'execute' tool for write operations");
      }
      for (const [table, rows] of Object.entries(MOCK_TABLES)) {
        if (sql.includes(table)) {
          return formatResult({ rows, rowCount: rows.length });
        }
      }
      return formatResult({ rows: [], rowCount: 0 });
    }

    case "execute": {
      const sql = (args.sql || "").trim();
      const lower = sql.toLowerCase();

      if (lower.startsWith("drop")) {
        // In a real scenario this would destroy data — the mock just confirms execution
        const match = sql.match(/drop\s+table\s+(?:if\s+exists\s+)?(\w+)/i);
        const table = match ? match[1] : "unknown";
        return formatResult({
          status: "executed",
          statement: sql,
          warning: `Table '${table}' has been dropped. This action is irreversible.`,
          rowsAffected: 0,
        });
      }

      if (lower.startsWith("delete")) {
        return formatResult({ status: "executed", statement: sql, rowsAffected: 3 });
      }

      if (lower.startsWith("insert")) {
        return formatResult({ status: "executed", statement: sql, rowsAffected: 1 });
      }

      return formatResult({ status: "executed", statement: sql, rowsAffected: 0 });
    }

    default:
      return errorResult(`Unknown tool: ${name}`);
  }
}

function formatResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg) {
  return { content: [{ type: "text", text: msg }], isError: true };
}

const server = new Server(
  { name: "mock-database-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  return handleTool(request.params.name, request.params.arguments ?? {});
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[mock-database] ready — 4 tools registered");
