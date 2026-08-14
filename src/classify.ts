import type { DiscoveredTool } from "./utils";

export type TrustLevel = "low" | "medium" | "high";

export interface ClassifiedTool extends DiscoveredTool {
  trust: TrustLevel;
  schema: unknown;
}

const HIGH = /delete|remove|destroy|drop|purge|wipe/i;
const MEDIUM = /create|write|update|insert|modify|send|post|execute|mutation/i;

export function classifyTool(toolName: string): TrustLevel {
  const action = toolName.includes("__")
    ? toolName.split("__").pop()!
    : toolName;
  if (HIGH.test(action)) return "high";
  if (MEDIUM.test(action)) return "medium";
  return "low";
}

export function classifyTools(
  tools: DiscoveredTool[],
  schemas: Map<string, unknown>
): ClassifiedTool[] {
  return tools.map((t) => ({
    ...t,
    trust: classifyTool(t.qualifiedName),
    schema: schemas.get(t.qualifiedName) ?? {},
  }));
}
