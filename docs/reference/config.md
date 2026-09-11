# Configuration Reference

> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core` — the
> schema `.describe()` strings are the single source of truth for these rows.

## Precedence

**Environment variables** resolve in this order (highest first):

```
1. one-shot          VAR=value noir ...
2. run profile env   run.profiles.<n>.env   (merges over)
3. THIS FILE         .noir/.env             <- recommended here
4. real environment  CI / container / launchd / shell rc
5. built-in default
```

`.noir/.env` therefore **wins for every key it defines** — a machine-global
export (`~/.zshrc`, `~/.claude/settings.json`, launchd, CI) cannot shadow it.
A git-*tracked* `.noir/.env` is refused outright, and `noir env` shows which
source won for each key. Full chain + recipes:
[Configuring a project with `.noir/.env`](../how-to/configure-env.md).

**Config keys** (`.noir/config.yml`) resolve by their own order: CLI flag >
environment variable (`NOIR_PROFILE`) > project `.noir/config.yml` >
built-in default. Integration tokens (e.g. `CLICKUP_API_TOKEN`) are env
vars, never config keys — see
[Environment Variables](environment.md),
[Run profiles](../how-to/host-profiles.md), and
[ClickUp setup](../how-to/clickup.md).

### General

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | `enum` | no | "claude" | Host adapter for emitted artifacts |
| `name` | `string` | no | — | Display name (defaults to the project dir basename) |
| `mode` | `enum` | no | "full" | Default SDD mode |

### daemon

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `daemon` | `object` | no | {"idleTimeoutSec":900} | Local daemon settings |
| `daemon.idleTimeoutSec` | `number` | no | 900 | Idle timeout before the daemon auto-stops (seconds) |
| `daemon.port` | `number` | no | — | Preferred daemon HTTP port (a preference: if taken, an ephemeral port is used) |

### context

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `context` | `object` | no | {"embedder":{"kind":"local","dim":384},"roots":[],"budgetTokens":4096} | Context retrieval settings |
| `context.embedder` | `object` | no | {"kind":"local","dim":384} | Embedder configuration |
| `context.roots` | `array` | no | [] | Configured index roots (informational) |
| `context.budgetTokens` | `number` | no | 4096 | Default context_search token budget |

### model

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | `object` | no | {} | Bounded model layer (provider-explicit; absent = fully degraded) |
| `model.defaultProvider` | `string` | no | — | Fallback provider key (into `providers`) for unassigned tiers |
| `model.tiers` | `object` | no | — | Per-tier provider overrides |
| `model.providers` | `record` | no | — | Configured model providers, keyed by name |
| `model.providers.<name>` | `record value` | yes | — | A named provider block |

### memory

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `memory` | `object` | no | {"consolidation":{"enabled":false}} | Cross-session memory settings |
| `memory.consolidation` | `object` | no | {"enabled":false} | Memory consolidation (LLM; opt-in + provider-explicit) |

### rules

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `rules` | `object` | no | {"enabled":true,"lengthBudgetKb":6} | Rules registry (parsed; consumer ships with the rule engine) |
| `rules.enabled` | `boolean` | no | true | Rule registry master switch |
| `rules.lengthBudgetKb` | `number` | no | 6 | Soft per-rule body budget (KB) |

### prd

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `prd` | `object` | no | {"mandatoryFor":["feature","epic"]} | Soft PRD gate settings |
| `prd.mandatoryFor` | `array` | no | ["feature","epic"] | Task classes that trigger the soft PRD gate at the spec gate |

### workflow

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `workflow` | `object` | no | {"gate":{"verify":{"required":false,"retryBudget":2},"research":{"recommendFor":["feature","epic"],"requireSource":true}}} | SDD workflow engine settings |
| `workflow.gate` | `object` | no | {"verify":{"required":false,"retryBudget":2},"research":{"recommendFor":["feature","epic"],"requireSource":true}} | Workflow gates (verify / research) |

### integrations

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `integrations` | `record` | no | {} | Opt-in integration overlays, keyed by integration name |
| `integrations.<name>` | `record value` | yes | — | A per-integration config overlay |

### update

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `update` | `object` | no | {"checkEnabled":true,"checkIntervalHours":24,"channel":"latest","minVersion":"1.6.0","display":"notice"} | Update checker (honors NOIR_DISABLE_UPDATE_CHECK / NOIR_DISABLE_UPDATES) |
| `update.checkEnabled` | `boolean` | no | true | Enable the async startup version check |
| `update.checkIntervalHours` | `number` | no | 24 | Version-check cache TTL (hours) |
| `update.channel` | `enum` | no | "latest" | Update channel |
| `update.minVersion` | `string` | no | "1.6.0" | Floor — update never installs below this |
| `update.display` | `enum` | no | "notice" | Notice mode (parsed; notice path only) |

### run

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `run` | `object` | no | {"profiles":{}} | Host orchestrator run settings |
| `run.defaultProfile` | `string` | no | — | Fallback profile name when no --profile flag / NOIR_PROFILE is set |
| `run.profiles` | `record` | no | {} | Named run profiles, keyed by name |
| `run.profiles.<name>` | `record value` | yes | — | A named host-binary bundle |

### workspace

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `workspace` | `object` | no | {"idleTimeoutSec":0} | Shared workspace settings |
| `workspace.idleTimeoutSec` | `number` | no | 0 | Idle timeout before a workspace daemon auto-stops (seconds; 0 = never) |


## Conditional requirements

- `model.providers.<name>.apiKeyEnv` — required only when the provider is remote
  (anonymous local providers like Ollama omit it).
- `integrations.<name>.{teamId,listId,spaceId}` — required only when the matching
  ClickUp flow needs workspace binding (see [ClickUp setup](../how-to/clickup.md)).
- `context.embedder.provider` / `context.embedder.model` / `context.embedder.baseURL` —
  `provider` is only meaningful when `kind` is `remote`; `baseURL` when `kind` is
  `ollama`; `model` applies to all three (a HuggingFace repo id for `local`).
- `memory.consolidation.*` — only meaningful when `memory.consolidation.enabled` is true.

## Secrets policy

`.noir/config.yml` is **committable project state** — never paste a token value into it.
`apiKeyEnv` stores a variable **NAME**, never an interpolation — write
`apiKeyEnv: ANTHROPIC_API_KEY`, never `apiKeyEnv: ${ANTHROPIC_API_KEY}`. The
model layer reads `process.env[<that name>]`, so the dollar-brace form resolves to
`undefined` and silently disables the provider. Only `run.profiles.<name>.env`
interpolates a dollar-brace reference. Put the **value** in `.noir/.env` — the
recommended project-scoped home, `0600` and gitignored, and the winner for every key
it defines — or in the real environment. Never pass tokens as CLI arguments (visible
in process lists). See
[Configuring a project with `.noir/.env`](../how-to/configure-env.md) and
[Environment Variables](environment.md) for the full placement + precedence rules.

## Honest notes

- `rules.enabled`, `update.display`, `context.roots`, `context.budgetTokens`, and `daemon.port`
  are parsed + validated but have no live consumer yet — declaring them now avoids
  schema churn when their feature ships. Do not rely on them.
- `rules.lengthBudgetKb` IS read: `noir doctor`'s RULES.md budget check.
- `run.*` is new in 1.13.0 (host profiles; first surfaced on `beta` as 1.12.0-beta.1). All other blocks predate it.
