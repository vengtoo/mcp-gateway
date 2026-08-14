import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ServerConfig } from "./types";

/**
 * Environment for a downstream MCP server process. Downstreams are the
 * least-trusted components the gateway touches, so they must never inherit the
 * gateway's own credentials or the host's full environment: start from the MCP
 * SDK's filtered default env (PATH, HOME, ... — no secrets), drop every
 * VENGTOO_* variable (API key, HTTP tokens), then apply only what the operator
 * explicitly configured for that server. An explicit `env` entry wins — even a
 * VENGTOO_* one — since that is deliberate operator intent.
 */
export function downstreamEnv(extra?: Record<string, string>): Record<string, string> {
  const env = getDefaultEnvironment();
  for (const key of Object.keys(env)) {
    if (key.startsWith("VENGTOO_")) delete env[key];
  }
  return { ...env, ...(extra ?? {}) };
}

export interface DiscoveredTool {
  qualifiedName: string;
  server: string;
  originalName: string;
  description: string;
  inputFields: string[];
}

export function extractFields(schema: unknown): string[] {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "properties" in schema
  ) {
    return Object.keys(
      (schema as { properties: Record<string, unknown> }).properties
    );
  }
  return [];
}

export async function discoverTools(
  name: string,
  cfg: ServerConfig
): Promise<{ tools: DiscoveredTool[]; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: cfg.command,
    args: cfg.args,
    env: downstreamEnv(cfg.env),
  });
  const client = new Client(
    { name: `vengtoo-gateway/${name}`, version: "0.1.0" },
    { capabilities: {} }
  );
  await client.connect(transport);
  const { tools } = await client.listTools();

  const discovered: DiscoveredTool[] = tools.map((t) => ({
    qualifiedName: `${name}__${t.name}`,
    server: name,
    originalName: t.name,
    description: t.description ?? "",
    inputFields: extractFields(t.inputSchema),
  }));

  return { tools: discovered, transport };
}
