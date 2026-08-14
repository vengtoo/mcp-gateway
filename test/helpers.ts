import type { GatewayConfig } from "../src/types";

export type { GatewayConfig };

/** Minimal valid config for tests (audit is stderr-only; nothing to configure). */
export function baseConfig(vengtoo: GatewayConfig["vengtoo"]): GatewayConfig {
  return {
    vengtoo: { timeoutMs: 2_000, ...vengtoo },
    subject: "agent:test",
    servers: { stub: { command: "true" } },
  };
}
