import type {
  DriftEvent,
  ServerSnapshot,
  ToolSnapshot,
} from "./types";

// The gateway reports only FACTS about what changed (change type, field, old/new
// values). It deliberately does NOT score how severe a change is — that judgment
// is computed cloud-side from these facts. The gateway is the least-trusted
// component and its inputs (tool names/schemas) are attacker-influenceable, so a
// severity computed here would be an influence path. Facts up, judgments central.
export function detectDrift(
  serverName: string,
  oldSnapshot: ServerSnapshot,
  newTools: ToolSnapshot[]
): DriftEvent[] {
  const events: DriftEvent[] = [];

  const oldMap = new Map(oldSnapshot.tools.map((t) => [t.name, t]));
  const newMap = new Map(newTools.map((t) => [t.name, t]));

  for (const [name, oldTool] of oldMap) {
    if (!newMap.has(name)) {
      events.push({
        toolName: name,
        serverName,
        changeType: "tool_removed",
        message: `Tool "${name}" was removed from server "${serverName}"`,
      });
      continue;
    }

    const newTool = newMap.get(name)!;
    events.push(...compareTools(serverName, oldTool, newTool));
  }

  for (const name of newMap.keys()) {
    if (!oldMap.has(name)) {
      events.push({
        toolName: name,
        serverName,
        changeType: "tool_added",
        message: `New tool "${name}" appeared on server "${serverName}"`,
      });
    }
  }

  return events;
}

function compareTools(
  serverName: string,
  oldTool: ToolSnapshot,
  newTool: ToolSnapshot
): DriftEvent[] {
  const events: DriftEvent[] = [];

  if (oldTool.description !== newTool.description) {
    events.push({
      toolName: oldTool.name,
      serverName,
      changeType: "description_changed",
      oldValue: oldTool.description,
      newValue: newTool.description,
      message: `Description changed for tool "${oldTool.name}"`,
    });
  }

  const oldProps = getProperties(oldTool.inputSchema);
  const newProps = getProperties(newTool.inputSchema);

  for (const key of Object.keys(oldProps)) {
    if (!(key in newProps)) {
      events.push({
        toolName: oldTool.name,
        serverName,
        changeType: "parameter_removed",
        field: key,
        oldValue: oldProps[key],
        message: `Parameter "${key}" removed from tool "${oldTool.name}"`,
      });
    } else if (oldProps[key]?.type !== newProps[key]?.type) {
      events.push({
        toolName: oldTool.name,
        serverName,
        changeType: "type_changed",
        field: key,
        oldValue: oldProps[key]?.type,
        newValue: newProps[key]?.type,
        message: `Parameter "${key}" type changed from "${oldProps[key]?.type}" to "${newProps[key]?.type}" in tool "${oldTool.name}"`,
      });
    }
  }

  for (const key of Object.keys(newProps)) {
    if (!(key in oldProps)) {
      events.push({
        toolName: oldTool.name,
        serverName,
        changeType: "parameter_added",
        field: key,
        newValue: newProps[key],
        message: `Parameter "${key}" added to tool "${oldTool.name}"`,
      });
    }
  }

  // Fail-closed catch-all: the field-level comparisons above only model a few
  // change shapes (top-level property add/remove/type, tool description). A
  // nested change — most importantly a *parameter description* edit, the
  // known MCP rug-pull prompt-injection vector — would otherwise produce no
  // event, letting blockOnDrift miss it and the baseline silently absorb it.
  if (
    events.length === 0 &&
    JSON.stringify(oldTool.inputSchema) !== JSON.stringify(newTool.inputSchema)
  ) {
    events.push({
      toolName: oldTool.name,
      serverName,
      changeType: "schema_changed",
      oldValue: oldTool.inputSchema,
      newValue: newTool.inputSchema,
      message: `Schema changed for tool "${oldTool.name}" (nested change — e.g. a parameter description)`,
    });
  }

  return events;
}

function getProperties(
  schema: unknown
): Record<string, { type?: string; [k: string]: unknown }> {
  if (
    typeof schema === "object" &&
    schema !== null &&
    "properties" in schema &&
    typeof (schema as Record<string, unknown>).properties === "object"
  ) {
    return (schema as { properties: Record<string, { type?: string }> }).properties;
  }
  return {};
}

export function logDriftEvents(events: DriftEvent[]): void {
  for (const e of events) {
    // Label the line with the change type (a fact), not a severity (a judgment).
    console.error(`[vengtoo-gateway] DRIFT ${e.changeType}: ${e.message}`);
  }
  if (events.length > 0) {
    console.error(
      `[vengtoo-gateway] drift summary: ${events.length} change(s) — severity is scored by the Vengtoo cloud`
    );
  }
}
