# Configuration Reference

> Auto-generated from `NoirConfigSchema` (Zod v4) in `@noir-ai/core`.

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `host` | `enum` | no | "claude" |  |
| `name` | `string` | no | — |  |
| `mode` | `enum` | no | "full" |  |
| `daemon` | `object` | no | {"idleTimeoutSec":900} |  |
| `context` | `object` | no | {"embedder":{"kind":"local","dim":384},"roots":[],"budgetTokens":4096} |  |
| `model` | `object` | no | {} |  |
| `memory` | `object` | no | {"consolidation":{"enabled":false}} |  |
| `rules` | `object` | no | {"enabled":true,"lengthBudgetKb":6} |  |
| `prd` | `object` | no | {"mandatoryFor":["feature","epic"]} |  |
| `workflow` | `object` | no | {"gate":{"verify":{"required":false,"retryBudget":2},"research":{"recommendFor":["feature","epic"],"requireSource":true}}} |  |
| `integrations` | `record` | no | {} |  |
| `update` | `object` | no | {"checkEnabled":true,"checkIntervalHours":24,"channel":"latest","minVersion":"1.6.0","display":"notice"} |  |
