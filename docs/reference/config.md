# Configuration Reference

> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core` — the
> schema `.describe()` strings are the single source of truth for these rows.

## Precedence

CLI flag > environment variable (`NOIR_PROFILE`) > project `.noir/config.yml` >
built-in default. The real environment always wins over `.noir/.env`, which
fills only unset keys. Integration tokens (e.g. `CLICKUP_API_TOKEN`) are env
vars, never config keys — see
[Environment Variables](environment.md),
[Run profiles](../how-to/host-profiles.md), and
[ClickUp setup](../how-to/clickup.md).

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | `enum` | no | "claude" | Host adapter for emitted artifacts |
| `name` | `string` | no | — | Display name (defaults to the project dir basename) |
| `mode` | `enum` | no | "full" | Default SDD mode |
| `daemon` | `object` | no | {"idleTimeoutSec":900} | Local daemon settings |
| `daemon.idleTimeoutSec` | `number` | no | 900 | Idle timeout before the daemon auto-stops (seconds) |
| `daemon.port` | `number` | no | — | Daemon HTTP port (optional; not yet wired to a consumer) |
| `context` | `object` | no | {"embedder":{"kind":"local","dim":384},"roots":[],"budgetTokens":4096} | Context retrieval settings |
| `context.embedder` | `object` | no | {"kind":"local","dim":384} | Embedder configuration |
| `context.roots` | `array` | no | [] | Configured index roots (informational) |
| `context.budgetTokens` | `number` | no | 4096 | Default context_search token budget |
| `model` | `object` | no | {} | Bounded model layer (provider-explicit; absent = fully degraded) |
| `model.defaultProvider` | `string` | no | — | Fallback provider key (into `providers`) for unassigned tiers |
| `model.tiers` | `object` | no | — | Per-tier provider overrides |
| `model.providers` | `record` | no | — | Configured model providers, keyed by name |
| `memory` | `object` | no | {"consolidation":{"enabled":false}} | Cross-session memory settings |
| `memory.consolidation` | `object` | no | {"enabled":false} | Memory consolidation (LLM; opt-in + provider-explicit) |
| `rules` | `object` | no | {"enabled":true,"lengthBudgetKb":6} | Rules registry (parsed; consumer ships with the rule engine) |
| `rules.enabled` | `boolean` | no | true | Rule registry master switch |
| `rules.lengthBudgetKb` | `number` | no | 6 | Soft per-rule body budget (KB) |
| `prd` | `object` | no | {"mandatoryFor":["feature","epic"]} | Soft PRD gate settings |
| `prd.mandatoryFor` | `array` | no | ["feature","epic"] | Task classes that trigger the soft PRD gate at the spec gate |
| `workflow` | `object` | no | {"gate":{"verify":{"required":false,"retryBudget":2},"research":{"recommendFor":["feature","epic"],"requireSource":true}}} | SDD workflow engine settings |
| `workflow.gate` | `object` | no | {"verify":{"required":false,"retryBudget":2},"research":{"recommendFor":["feature","epic"],"requireSource":true}} | Workflow gates (verify / research) |
| `integrations` | `record` | no | {} | Opt-in integration overlays, keyed by integration name |
| `update` | `object` | no | {"checkEnabled":true,"checkIntervalHours":24,"channel":"latest","minVersion":"1.6.0","display":"notice"} | Update checker (honors NOIR_DISABLE_UPDATE_CHECK / NOIR_DISABLE_UPDATES) |
| `update.checkEnabled` | `boolean` | no | true | Enable the async startup version check |
| `update.checkIntervalHours` | `number` | no | 24 | Version-check cache TTL (hours) |
| `update.channel` | `enum` | no | "latest" | Update channel |
| `update.minVersion` | `string` | no | "1.6.0" | Floor — update never installs below this |
| `update.display` | `enum` | no | "notice" | Notice mode (parsed; notice path only) |
| `run` | `object` | no | {"profiles":{}} | Host orchestrator run settings |
| `run.defaultProfile` | `string` | no | — | Fallback profile name when no --profile flag / NOIR_PROFILE is set |
| `run.profiles` | `record` | no | {} | Named run profiles, keyed by name |

## Honest notes

- `rules.*`, `update.display`, `context.roots`, `context.budgetTokens`, and `daemon.port`
  are parsed + validated but have no live consumer yet — declaring them now avoids
  schema churn when their feature ships. Do not rely on them.
