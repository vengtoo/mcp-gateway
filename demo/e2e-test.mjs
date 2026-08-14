#!/usr/bin/env node

/**
 * End-to-end test: spawns the gateway as an MCP client, lists tools,
 * then calls tools to verify allow/deny decisions.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["../dist/cli.js", "--config", "demo-database.config.json"],
  env: { ...process.env },
  cwd: import.meta.dirname,
});

const client = new Client(
  { name: "e2e-test", version: "1.0.0" },
  { capabilities: {} }
);

await client.connect(transport);

// 1. List tools
const { tools } = await client.listTools();
console.log(`\n=== Tools registered: ${tools.length} ===`);
for (const t of tools) {
  console.log(`  - ${t.name}: ${t.description}`);
}

// 2. Test: query (should ALLOW and return data)
console.log("\n=== Test 1: database__query (should ALLOW) ===");
const r1 = await client.callTool({ name: "database__query", arguments: { sql: "SELECT * FROM users" } });
console.log("  Result:", r1.content[0].text.substring(0, 120));
console.log("  isError:", r1.isError ?? false);

// 3. Test: list_tables (should ALLOW)
console.log("\n=== Test 2: database__list_tables (should ALLOW) ===");
const r2 = await client.callTool({ name: "database__list_tables", arguments: {} });
console.log("  Result:", r2.content[0].text.substring(0, 120));
console.log("  isError:", r2.isError ?? false);

// 4. Test: execute with safe SQL (should ALLOW)
console.log("\n=== Test 3: database__execute INSERT (should ALLOW) ===");
const r3 = await client.callTool({ name: "database__execute", arguments: { sql: "INSERT INTO users (email) VALUES ('test@test.com')" } });
console.log("  Result:", r3.content[0].text.substring(0, 120));
console.log("  isError:", r3.isError ?? false);

// 5. Test: execute with DROP TABLE (should DENY)
console.log("\n=== Test 4: database__execute DROP TABLE (should DENY) ===");
const r4 = await client.callTool({ name: "database__execute", arguments: { sql: "DROP TABLE users" } });
console.log("  Result:", r4.content[0].text.substring(0, 200));
console.log("  isError:", r4.isError ?? false);

// 6. Test: execute with TRUNCATE (should DENY)
console.log("\n=== Test 5: database__execute TRUNCATE (should DENY) ===");
const r5 = await client.callTool({ name: "database__execute", arguments: { sql: "TRUNCATE TABLE users" } });
console.log("  Result:", r5.content[0].text.substring(0, 200));
console.log("  isError:", r5.isError ?? false);

// 7. Test: execute with DELETE FROM (should DENY)
console.log("\n=== Test 6: database__execute DELETE (should DENY) ===");
const r6 = await client.callTool({ name: "database__execute", arguments: { sql: "DELETE FROM users WHERE id = 1" } });
console.log("  Result:", r6.content[0].text.substring(0, 200));
console.log("  isError:", r6.isError ?? false);

console.log("\n=== All tests complete ===");
process.exit(0);
