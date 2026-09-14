# Connecting through a gateway

A **gateway** is any Anthropic-shaped endpoint that is not `api.anthropic.com`
— Z.AI, LiteLLM, OpenRouter, Kimi, a corporate proxy, a local model server.
There are two independent places to point at one, and the first step is knowing
which question you are answering:

| Path | What it configures | Where it lives |
|---|---|---|
| **Host** | the agentic CLI that `noir run` drives (Claude Code by default) | environment variables in `.noir/.env` |
| **Model** | Noir's own model layer (memory consolidation) | `model.providers.<name>` in `.noir/config.yml` |

They are configured separately on purpose. The host has its own credential
model and its own variable names; Noir's model layer is provider-explicit and
reads only its config. Setting one does not set the other.

## The host path — `noir run` and `.noir/.env`

`noir run` spawns the host as a child process and passes its environment
through by inheritance. Every value in `.noir/.env` is therefore in the host's
environment, and the gateway variables below are what the host reads:

| Variable | What it does |
|---|---|
| `ANTHROPIC_BASE_URL` | The gateway's base URL. Host-only — give the origin and let the host append its own message path. |
| `ANTHROPIC_AUTH_TOKEN` | The credential, sent as `Authorization: Bearer`. |
| `ANTHROPIC_API_KEY` | The other credential shape: sent as `x-api-key`. |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` / `_SONNET_MODEL` / `_OPUS_MODEL` | Remap the model aliases to the ids your gateway serves. |
| `API_TIMEOUT_MS` | Per-request timeout in milliseconds. |

`.noir/.env` is applied to Noir's own environment and the processes it spawns —
it is never exported to your shell, so a `claude` you launch by hand does not
see it. Drive the host with `noir run` (or through the daemon) for the gateway
to apply; remove the lines when you want your normal account back.

### Do not set both credentials

`ANTHROPIC_AUTH_TOKEN` becomes a `Bearer` header, `ANTHROPIC_API_KEY` becomes
`x-api-key`. Setting **both** is an auth conflict, and the symptom is an
authentication failure that looks like a stale key. Pick one — `AUTH_TOKEN` for
a gateway that expects a Bearer token, `API_KEY` for one that expects the
Anthropic header. If your shell already exports one of them, make the file's
intent explicit (see the OpenRouter example below).

### Z.AI

```bash
# .noir/.env                                  (gitignored — never commit)
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_AUTH_TOKEN=replace-with-your-zai-token
# The host sends the alias (haiku / sonnet / opus) unless you remap it:
ANTHROPIC_DEFAULT_HAIKU_MODEL=glm-5.3-flash
ANTHROPIC_DEFAULT_SONNET_MODEL=glm-5.3
ANTHROPIC_DEFAULT_OPUS_MODEL=glm-5.3
```

### LiteLLM

```bash
# .noir/.env
ANTHROPIC_BASE_URL=http://localhost:4000
ANTHROPIC_AUTH_TOKEN=replace-with-your-litellm-key

# …or the pass-through route, when you want LiteLLM to forward to the
# Anthropic API unchanged:
# ANTHROPIC_BASE_URL=http://localhost:4000/anthropic
```

### OpenRouter

OpenRouter takes the key as a Bearer token. If your shell already exports
`ANTHROPIC_API_KEY` for direct Anthropic use, set it explicitly empty here: an
empty value in `.noir/.env` still wins over the exported one, which keeps the
two credentials from conflicting.

```bash
# .noir/.env
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=replace-with-your-openrouter-key
ANTHROPIC_API_KEY=
```

### Checking what the host will get

`noir env` reports each key's winning source — `.noir/.env` when the file
defines it, `environment` when it does not — and never prints a value:

```bash
noir env
```

If a run still fails to authenticate, Noir's error message names every
credential variable in effect *and* the side that supplied it, so "unset it"
points at the right place rather than being a guess.

## The model path — `model.providers` in `config.yml`

Noir's own model layer (used by memory consolidation) is pointed at a gateway
through config, not the environment. The provider block takes the transport
fields directly, and the credentials stay in `.noir/.env` behind a **name**:

```yaml
# .noir/config.yml
model:
  providers:
    gateway:
      baseURL: https://api.z.ai/api/anthropic
      authTokenEnv: ZAI_AUTH_TOKEN     # a NAME, never the value
      timeoutMs: 300000                # milliseconds, minimum 1000
      model: glm-5.3
  tiers:
    default:
      provider: gateway
```

```bash
# .noir/.env
ZAI_AUTH_TOKEN=replace-with-your-zai-token
```

`authTokenEnv` is the Bearer variant; `apiKeyEnv` is the `x-api-key` variant.
Both store the variable's **name** — `authTokenEnv: ZAI_AUTH_TOKEN` reads
`$ZAI_AUTH_TOKEN`, while `authTokenEnv: ${ZAI_AUTH_TOKEN}` resolves to nothing
and leaves the provider keyless, silently.

Noir's model layer reads only this config. It does **not** fall back to
`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, or `ANTHROPIC_API_KEY` from the
environment, so a request can never be routed somewhere the config did not
choose. A provider that names `apiKeyEnv` or `authTokenEnv` and finds neither
set is treated as keyless and degrades to templates — never a silent paid call.
That is why the two paths above are configured separately and neither one
implies the other.

## See also

- [environment.md](../reference/environment.md) — every variable Noir reads,
  the precedence chain, and the deny-list.
- [config.md](../reference/config.md) — the `model.providers` schema.
- [configure-env.md](configure-env.md) — what belongs in `.noir/.env`, and
  `noir env`.
- [host-profiles.md](host-profiles.md) — per-invocation overrides via run
  profiles.
