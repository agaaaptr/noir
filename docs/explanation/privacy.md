# Privacy & Security

Noir is local-first by design. No data leaves your machine unless you explicitly opt in.

## Embedding & Retrieval

- **Local-first embedder.** Default runs in-process (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim, L2-normalized) — offline and private. The model downloads once (~22 MB to `~/.noir/models/`).
- **Remote embedders are opt-in.** OpenAI, Voyage, Cohere via Matryoshka-384, and Ollama are supported but NEVER the default. You must explicitly configure them in `.noir/config.yml`.

## Model Layer

- **Provider-explicit, never silent paid.** The model layer resolves the provider solely from explicit config (`req.provider || cfg.defaultProvider`). It is never inferred from env-var presence.
- **Missing key ⇒ `null` / `{ok:false}`** BEFORE any SDK client is constructed. The Anthropic/OpenAI SDKs' own env-var fallbacks can never trigger a paid call.
- **Memory consolidation** is opt-in and gated on `memory.consolidation.enabled` — refuses cleanly (`'no-provider'`) without a provider. No silent LLM consolidation.

## Data Storage

- **Project-scoped by canonical ID.** Store keys use a UUID-based `ProjectId`, never a filesystem path (paths break across machines).
- **SQLite database** at `.noir/store/<projectId>.db` — single-writer (daemon), local-only.
- **Indexed content** lives in the same local DB. No cloud sync, no telemetry.

## Governance

- **Audit trail:** every gated write (e.g., `noir_clickup_write`) appends to `.noir/audit/integration-*.jsonl`.
- **Memory operations:** `memory_forget` deletes with reason; `memory_sessions` lists per-session rollups. (Noir has no `memory_export` tool — that is the *agentmemory plugin*'s surface, not a Noir tool.)
- **Never auto-captures.** Memory save is explicit; an opt-in hooks template is provided but never auto-wired.

## Environmental Variables

Config stores env-var **names**, not values. Secrets are read at call time:
```yaml
model:
  providers:
    anthropic:
      apiKeyEnv: ANTHROPIC_API_KEY   # name only — value read at runtime
```

`.noir/.env` is the **recommended home for project-scoped values** — gitignored, created at `0600` by `noir init`, and read in-process so it applies however the command was launched. It **wins for every key it defines**; the real environment is the fallback for the keys it does not define, so a machine-global export cannot shadow it. (A git-*tracked* `.noir/.env` is refused outright; `noir env` shows which source won for each key — see [configure-env.md](../how-to/configure-env.md).) `.noir/config.yml` stores a variable **name**, never literal secret values — `apiKeyEnv: ANTHROPIC_API_KEY`, never `apiKeyEnv: ${ANTHROPIC_API_KEY}`, which would resolve `process.env['${ANTHROPIC_API_KEY}']` → `undefined` and silently disable the provider. Only `run.profiles.<name>.env` interpolates `${VAR}`.
