# Configuration Reference

> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | `unknown` | no | "claude" |  |
| `name` | `unknown` | no | — |  |
| `mode` | `unknown` | no | "full" |  |
| `daemon` | `unknown` | no | {"idleTimeoutSec":900} |  |
| `context` | `unknown` | no | {"embedder":{"kind":"local","dim":384},"roots":[],"budgetTokens":4096} |  |
| `model` | `unknown` | no | {} |  |
| `memory` | `unknown` | no | {"consolidation":{"enabled":false}} |  |
| `rules` | `unknown` | no | {"enabled":true,"lengthBudgetKb":6} |  |
| `prd` | `unknown` | no | {"mandatoryFor":["feature","epic"]} |  |
| `integrations` | `unknown` | no | {} |  |
| `update` | `unknown` | no | {"checkEnabled":true,"checkIntervalHours":24,"channel":"latest","minVersion":"1.6.0","display":"notice"} |  |
