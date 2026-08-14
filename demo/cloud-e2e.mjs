#!/usr/bin/env node
// Minimal cloud test: connect through the gateway, list tools, fire two
// calls, and print the decision the Vengtoo Cloud engine returned.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["../dist/cli.js", "--config", "cloud-test.config.json"],
  env: { ...process.env },
  cwd: import.meta.dirname,
});
const client = new Client({ name: "cloud-e2e", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const cases = [
  ["query   SELECT * FROM users        (expect ALLOW)", "database__query",   { sql: "SELECT * FROM users" }],
  ["execute INSERT INTO users ...      (expect ALLOW)", "database__execute", { sql: "INSERT INTO users (email) VALUES ('a@b.com')" }],
  ["execute DROP TABLE users          (expect DENY)",  "database__execute", { sql: "DROP TABLE users" }],
  ["execute DELETE FROM users WHERE.. (expect DENY)",  "database__execute", { sql: "DELETE FROM users WHERE id = 1" }],
];
for (const [label, name, args] of cases) {
  try {
    const r = await client.callTool({ name, arguments: args });
    console.log(`\n[${label}]  isError=${r.isError ?? false}`);
    console.log("   ->", (r.content?.[0]?.text ?? "").substring(0, 260));
  } catch (e) {
    console.log(`\n[${label}]  threw: ${e.message}`);
  }
}
process.exit(0);
