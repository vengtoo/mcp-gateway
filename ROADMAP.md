# Roadmap

Where the Vengtoo MCP Gateway is headed. Items are grouped by horizon, not
promised order — feedback and contributions can reprioritize them. If one of
these matters to your deployment, open an issue and say so; that's the
strongest signal we get.

## Near term

### Per-caller auth, grade 2: validated credentials
Today's `http.callers` maps static bearer tokens to subjects (grade 1 —
shipped). Grade 2 validates a real credential instead: OAuth access tokens per
the MCP authorization spec (via the SDK's `req.auth` seam) and/or
Vengtoo-issued API keys checked against the cloud, with the subject derived
from validated claims. Buys expiry, revocation, and rotation without config
edits or restarts.

### Downstream resilience
Downstream servers are spawned once at startup. If one crashes, its tools stay
dead until the gateway restarts; a slow-starting server delays boot. Planned:
restart with backoff, per-downstream health in `/healthz`, and failure
isolation so one bad server never takes the rest of the fleet down.

### Dynamic tool lists (`tools/list_changed`)
The tool index is a boot-time snapshot. MCP servers can announce tool-list
changes at runtime; the gateway should re-discover, re-run drift detection,
and re-sync on that signal. This is a security item as much as a convenience:
it closes the window where a server adds a new tool after startup and the
gateway doesn't see it until the next restart.

### Prometheus metrics
A `/metrics` endpoint for HTTP mode: decision counts and latencies, deny
rates by reason, live sessions, downstream health. The Vengtoo Agent already
exposes this; the gateway should match.

### Remote downstream MCP servers
Connect to downstream servers over Streamable HTTP, not only by spawning
stdio subprocesses. Unlocks proxying hosted MCP servers and running the
gateway where the tools aren't.

## Mid term

- **HITL push over SSE** — resolve human approvals via the server→client
  stream instead of blocking-poll, so approvals land the moment they're made.
- **Per-caller / per-tool rate limiting** — enforce quotas at the gateway
  edge, configured from the same plane as policies.
- **Resources and prompts proxying** — govern all three MCP primitives, not
  just tools.
- **Hot config reload** — add/remove downstream servers and callers without
  dropping live sessions.
- **Docker image + Helm chart** — first-class container and Kubernetes
  deployment for HTTP mode.

## Longer term / exploratory

- **Content-level guardrails** — runtime inspection of tool results and
  descriptions (PII redaction, injection heuristics). Same trust model as
  drift: the gateway reports facts, the cloud scores them.
- **Resumable sessions** — Streamable HTTP resumability (event store) so
  long-lived approval waits survive network blips.
- **Newer MCP capabilities** — sampling and elicitation passthrough with
  policy hooks.

## Related (Vengtoo Agent)

Two items tracked in the [agent](https://github.com/vengtoo/agent) repo that
affect gateway deployments using a local agent:

- Disk cache for native policy bundles (agent restarts survive cloud outages).
- Watch-stream keepalive + half-open connection detection.
