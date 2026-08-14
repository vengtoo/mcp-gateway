import type { GatewayConfig } from "./types";
import { discoverTools } from "./utils";

export async function listTools(config: GatewayConfig): Promise<void> {
  const entries: Array<{
    qualifiedName: string;
    server: string;
    originalName: string;
    description: string;
    inputFields: string[];
  }> = [];

  for (const [name, cfg] of Object.entries(config.servers)) {
    try {
      const { tools, transport } = await discoverTools(name, cfg);
      entries.push(...tools);
      await transport.close();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[!] Failed to connect to "${name}": ${message}`);
    }
  }

  if (entries.length === 0) {
    console.log("No tools discovered from downstream servers.");
    process.exit(0);
  }

  console.log(`\nDiscovered ${entries.length} tool(s) across ${Object.keys(config.servers).length} server(s):\n`);
  console.log("─".repeat(70));

  let currentServer = "";
  for (const e of entries) {
    if (e.server !== currentServer) {
      currentServer = e.server;
      console.log(`\n  Server: ${currentServer}`);
      console.log("  " + "─".repeat(40));
    }
    console.log(`\n    ${e.qualifiedName}`);
    if (e.description) {
      console.log(`      ${e.description}`);
    }
    if (e.inputFields.length > 0) {
      console.log(`      inputs: ${e.inputFields.join(", ")}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log("\nUse these qualified names in your Rego policy. Example:\n");
  console.log("  allow if {");
  console.log(`      input.resource.name == "${entries[0].qualifiedName}"`);
  console.log("  }");
  if (entries[0].inputFields.length > 0) {
    const field = entries[0].inputFields[0];
    console.log(`\n  # Access tool arguments via input.resource.attributes.${field}`);
  }
  console.log("");

  process.exit(0);
}
