#!/usr/bin/env node

import { readFileSync } from "fs";
import { resolve } from "path";
import type { GatewayConfig } from "./types";
import { startGateway } from "./gateway";
import { setStateNamespace, stateNamespace } from "./state-dir";

const config = loadConfig();

// Namespace all per-tenant sync state (hashes/snapshots/enforced) by the active
// API key so pointing this machine at a new tenant starts from a clean baseline
// instead of reusing the previous tenant's cached hashes (which would trigger a
// silent "tools unchanged — skipping sync" and never register the new tenant).
// Must run AFTER the VENGTOO_API_KEY env override in loadConfig() and BEFORE any
// sync/state use in startGateway. The gateway identity stays global (see
// gateway-id.ts), so this does not mint a duplicate gateway on key rotation.
setStateNamespace(config.vengtoo.apiKey);
console.error(`[vengtoo-gateway] state namespace: ${stateNamespace()}`);

if (process.argv.includes("--list-tools")) {
  import("./list-tools").then((m) => m.listTools(config));
} else if (process.argv.includes("--generate-policy")) {
  const outFlag = process.argv.indexOf("--generate-policy");
  // Only treat the next token as the output path if it isn't another flag —
  // `--generate-policy --config x.json` must not write a file named "--config".
  const next = process.argv[outFlag + 1];
  const outPath = next && !next.startsWith("-") ? next : "policy.yaml";
  import("./generate-policy").then((m) => m.generatePolicy(config, outPath));
} else {
  startGateway(config).catch((err) => {
    console.error("[vengtoo-gateway] fatal:", err);
    process.exit(1);
  });
}

/**
 * Applies an environment override, warning when it silently replaces a different
 * value already set in the config file. Env wins (12-factor), but the operator
 * is told — a mismatched API key otherwise redirects every sync to the wrong
 * tenant with no visible sign. Secrets are masked to their last 4 chars.
 */
function applyEnvOverride(
  name: string,
  envVal: string | undefined,
  cfgVal: string | undefined,
  set: (v: string) => void,
  mask = false
): void {
  if (!envVal) return;
  if (cfgVal && cfgVal !== envVal) {
    const show = (v: string) => (mask ? `…${v.slice(-4)}` : v);
    console.error(
      `[vengtoo-gateway] WARNING: ${name} env var overrides the value in your config ` +
        `(config=${show(cfgVal)} env=${show(envVal)}) — using the ENV value. ` +
        `Unset it or align them if this is unintended.`
    );
  }
  set(envVal);
}

// Truthy env flag: "true"/"1"/"yes"/"on" (case-insensitive). Anything else is false.
function envBool(v: string | undefined): boolean {
  if (!v) return false;
  return ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
}

function loadConfig(): GatewayConfig {
  const configFlag = process.argv.indexOf("--config");
  const configPath =
    configFlag !== -1 && process.argv[configFlag + 1]
      ? resolve(process.argv[configFlag + 1])
      : resolve("gateway.config.json");

  try {
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw) as GatewayConfig;

    if (!config.vengtoo) throw new Error("missing 'vengtoo' section");
    if (!config.subject) throw new Error("missing 'subject'");
    if (!config.servers || Object.keys(config.servers).length === 0) {
      throw new Error("missing 'servers' — configure at least one downstream MCP server");
    }

    // Env overrides config (12-factor), but do it LOUDLY when both are set and
    // differ — a stale VENGTOO_API_KEY silently syncing to the wrong tenant is a
    // real footgun (it cost a long debug detour once).
    applyEnvOverride("VENGTOO_API_KEY", process.env.VENGTOO_API_KEY, config.vengtoo.apiKey,
      (v) => { config.vengtoo.apiKey = v; }, true);
    applyEnvOverride("VENGTOO_AGENT_URL", process.env.VENGTOO_AGENT_URL, config.vengtoo.agentUrl,
      (v) => { config.vengtoo.agentUrl = v; });
    applyEnvOverride("VENGTOO_SUBJECT", process.env.VENGTOO_SUBJECT, config.subject,
      (v) => { config.subject = v; });

    // Env opt-in for per-identity tools/list filtering (default off).
    if (envBool(process.env.MCP_FILTER_TOOLS_LIST)) config.vengtoo.filterToolsList = true;
    if (envBool(process.env.MCP_FILTER_TOOLS_LIST_FAIL_CLOSED)) config.vengtoo.filterToolsListFailClosed = true;

    applyTransportOverrides(config);
    if (config.vengtoo.agentUrl) {
      try { new URL(config.vengtoo.agentUrl); } catch {
        throw new Error(`'vengtoo.agentUrl' is not a valid URL: ${config.vengtoo.agentUrl}`);
      }
    }
    if (config.vengtoo.cloudUrl) {
      try { new URL(config.vengtoo.cloudUrl); } catch {
        throw new Error(`'vengtoo.cloudUrl' is not a valid URL: ${config.vengtoo.cloudUrl}`);
      }
    }
    for (const [name, srv] of Object.entries(config.servers)) {
      if (!srv.command || typeof srv.command !== "string") {
        throw new Error(`server '${name}' must have a non-empty 'command' string`);
      }
    }
    if (config.vengtoo.timeoutMs !== undefined) {
      if (typeof config.vengtoo.timeoutMs !== "number" || config.vengtoo.timeoutMs <= 0) {
        throw new Error(`'vengtoo.timeoutMs' must be a positive number`);
      }
    }

    return config;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(`Config not found: ${configPath}`);
      console.error(`Usage: vengtoo-mcp-gateway --config <path>`);
      process.exit(1);
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Invalid config: ${message}`);
    process.exit(1);
  }
}

/**
 * Folds transport selection (stdio vs http) and HTTP listen settings from CLI
 * flags and environment into the loaded config. Precedence: CLI flag > env var >
 * config file. Throws on a malformed --port so a typo fails loudly at startup
 * rather than silently binding the default.
 */
function applyTransportOverrides(config: GatewayConfig): void {
  const flag = (name: string): string | undefined => {
    const i = process.argv.indexOf(name);
    return i !== -1 ? process.argv[i + 1] : undefined;
  };

  const wantHttp =
    process.argv.includes("--http") ||
    process.env.VENGTOO_GATEWAY_TRANSPORT === "http" ||
    config.transport === "http";
  if (!wantHttp) return;

  config.transport = "http";
  const http = (config.http ??= {});

  const portRaw = flag("--port") ?? process.env.VENGTOO_GATEWAY_PORT ?? process.env.PORT;
  if (portRaw !== undefined) {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port '${portRaw}' — must be an integer 1–65535`);
    }
    http.port = port;
  }

  const host = flag("--host") ?? process.env.VENGTOO_GATEWAY_HOST;
  if (host) http.host = host;

  const path = flag("--path") ?? process.env.VENGTOO_GATEWAY_PATH;
  if (path) http.path = path;
}
