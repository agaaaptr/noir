# Changelog

Notable changes to the Noir toolkit, newest first. Slices follow the roadmap (`docs/roadmap.md`); per-slice design lives in `docs/superpowers/specs/`.

## v1.0 — release-ready (2026-07-25)

**v1.0 ACCEPTANCE-COMPLETE.** **10 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`; **729/729 tests green** (was 142 at the skeleton); build / typecheck / lint green. All committed locally on `develop` (**not pushed**).

**What shipped (S6–S9 + the skeleton S0–S5):**
- **S6 Context** — embedded hybrid retrieval: local in-process MiniLM embeddings + BM25 ∪ kNN fused by Reciprocal Rank Fusion.
- **S8 Model** — thin single-shot model library (`anthropic` / `openai` / `openai-compatible`); first-class `null` degradation; agent loops impossible by construction (no `tools`/`stream` on the request).
- **S7 Memory** — cross-session memory layered on the store (no schema migration); explicit-save default + opt-in Claude Code hooks template; append-only consolidation gated on the `memory.consolidation.enabled` master switch (never a silent paid call).
- **S9 CLI/TUI** — commander command tree + `@clack/prompts` home; stable exit codes; `status` probe-only (works daemon-down); every capability reachable from one shell entry point.
- Plus **S0–S5**: walking skeleton (stdio + daemon Streamable HTTP), S1 stores (SQLite + FTS5 + sqlite-vec), S4 SDD workflow engine, S5 builtin skills + compiler (**31 skills** = 19 full + 12 stub).

**End-to-end dogfood — PASSED 14/14:** real local embeddings → `context_search` hits; memory save→recall; workflow start→advance; durability across daemon restart; bounded-model degrades to `null` with no key.

**Finalization cleanups applied:** zod consolidated to **v4**; root **README rewritten** for the v1.0 toolkit; dead code + unused deps removed; biome / mcp-config / content-hash / jsdoc / re-export nits fixed.

All MVP v1.0 acceptance criteria met. **Next: cut the v1.0 release (publish / tag).** Deferred items are consolidated in the **v1.x backlog** in `docs/roadmap.md` (S10 more hosts, S11 distribution/SDK, plus per-area debt lists — daemon, CLI/TUI, context, memory, model, toolchain).

---

## S9 — CLI/TUI home screen (2026-07-25)

**Release-ready. v1.0 FEATURE-COMPLETE (S6–S9 done).** 729/729 tests green (was 501); build / typecheck / lint green. All on branch `develop`, local (not pushed). NO new package — the existing `@noir-ai/cli` was overhauled (total stays 10 packages).

### Added
- **Commander Command tree** replacing the hand-rolled `parseArgs` dispatcher (behavior-preserving: `init` / `sync` / `mcp serve` / `daemon start|stop` / `doctor` unchanged; the Gate-1 stdio subprocess test still passes). `exitOverride` + `configureOutput` so the process never `exit()`s mid-test and help/errors go to stderr.
- **Global flags** `--json` / `--no-input` / `--quiet` / `--verbose` / `--cwd` parsed in any position.
- **Stable exit codes:** 0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled. **Data → stdout, diagnostics → stderr.** `isInteractive()` gates every prompt (no hangs in CI / pipes / scripts).
- **Interactive home:** bare `noir` → `@clack/prompts` menu when TTY; `status` (human) when non-interactive; `status --json` under `--json`.
- **Commands:** `status` (probe-only — works daemon-down), `context {search,index,status}`, `memory {recall,save,sessions,forget,consolidate}`, `skills {list,sync}`, `task {new,status,advance,next}`, `daemon {start,stop,status,restart}`, `doctor` (config / store / embedder / native-deps / provider-status via `resolveModelConfig` — NO live model call).
- **Store-touching commands are MCP clients to the daemon** (`ensureDaemonRunning` + `@modelcontextprotocol/client` over HTTP).
- **New daemon MCP tools** `workflow_start` + `workflow_advance` (gated `ctx.engine`) backing `task new` / `advance`.
- **New runtime deps:** commander, @clack/prompts, picocolors, cli-table3, ora, @modelcontextprotocol/client.

### Changed
- `status` is now **probe-only**: it reports daemon state honestly and NEVER auto-starts a daemon (works daemon-down: exit 0, `daemon:{running:false}`). Active commands (`context *`, `memory *`, `task *`) still start/require the daemon for v1.
- Bare `noir` in a non-interactive context now dispatches to `status` (was `printHelp`).
- `daemon --detach` is foreground-honest: it returns exit code 2 ("not implemented, tracked v1.x") rather than pretending to background.

### Fixed
- Opus final review (2 CRITICAL + 2 IMPORTANT — ALL FIXED + tested):
  - **C1 (silent daemon auto-start):** `status` no longer starts a daemon as a side effect of probing — it is read-only and reports daemon-down honestly.
  - **C2 (`--json` daemon-down envelope):** emits a single clean JSON envelope (was doubly-encoded — the error wrapper was itself JSON-stringified).
  - **I1 (`task new`/`advance` were permanent stubs):** now wired end-to-end via the new `workflow_start` / `workflow_advance` daemon MCP tools (gated `ctx.engine`).
  - **I2 (bare `noir` non-interactive):** runs `status` instead of `printHelp`, so scripts / pipes get a real machine-readable snapshot.

### Known v0 debt (deferred)
- Full-screen Ink/blessed TUI — v2 (S9 ships a `@clack/prompts` menu, not a full-screen TUI).
- Backgrounded daemon detach / socket-activation — v1.x (`daemon --detach` honestly returns exit 2 for v1).
- In-process read-only store fallback for `context *` / `memory *` / `task *` — daemon-required for v1; `status` is the only probe-only command.
- `task` id/slug distinction collapsed to slug for v1 (single namespace).

## S7 — Memory management (2026-07-25)

**Release-ready.** 501/501 tests green (was 340); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/memory`** (10th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`). Cross-session memory layered **ON TOP of the store — no schema migration.**
- **Observations** via `indexDoc({source:'memory'})` (FTS5) + `upsertVec({source:'memory'})` (sqlite-vec, 384-dim) + KV `memory:obs:<id>` (authoritative full row) + `memory:sessions` / `memory:index` rollups. Dev-flavored open-enum taxonomy: `pattern | preference | architecture | bug | workflow | fact | decision | lesson` (`lesson` reserved for consolidation output; unknown values accepted + stored).
- **`save` / `recall` / `search` / `sessions` / `forget` / `consolidate`.** Recall **reuses S6's hybrid retrieval**: store `searchFt` + `knn` scoped to `source:'memory'` → `fuseRrf` (Reciprocal Rank Fusion, k=60 — imported from `@noir-ai/context`) → cheap regex entity-boost (identifiers / paths, no LLM) → hydrate FULL content from KV (never truncated, blueprint §9 / DS-9). BM25-only degraded fallback when no embedder.
- **Daemon:** resolves the embedder ONCE and passes the same `EmbedFn` to both `ContextEngine` and `MemoryEngine`; new `packages/daemon/src/memory-seam.ts`. 5 MCP tools (`memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`) + conditional `memory_consolidate`, all gated on `ctx.memory` (mirrors `ctx.store` / `ctx.engine`).
- **Consolidation:** append-only, explicitly-invoked job consuming S8 `complete()`. Emits derived `type:'lesson'` with `provenance:[ids]`; originals never mutated or deleted (reversible + auditable).
- **Config:** new `memory:` block in `NoirConfigSchema` (`consolidation:{enabled, provider?, model?, types?}`); `resolveMemoryConfig` bridge (pure projection; no core→memory import cycle) wired through the daemon.
- **Capture:** explicit-save is the default; a host-neutral `CaptureEvent` type + an **OPT-IN** Claude Code hooks template (a doc/settings snippet the user installs; NEVER auto-wired, never silent).
- **2 new builtin skills** `noir-recall` + `noir-remember` (skills pack now 31 = 19 full + 12 stub).

### Changed
- Consolidation capability is gated on the user's `memory.consolidation.enabled` master switch (NOT on `model.defaultProvider`); `enabled:false` ⇒ `memory_consolidate` tool unregistered + `consolidate` refuses `{ok:false, reason:'no-provider'}` with no model call — regardless of other model config.
- The daemon constructs a single shared embedder for context + memory (was: context-only).

### Security
- Opus final review (1 CRITICAL — FIXED + tested; all other blueprint D6 hard rules clean). **CRITICAL:** consolidation was initially gated on `model.defaultProvider`, which left a path to a silent paid LLM call (blueprint §9 anti-pattern). Now gated on the explicit `memory.consolidation.enabled` master switch — `enabled:false` refuses with no model call before any provider resolution. Verified by a no-provider test asserting zero model invocation. Remaining D6 rules clean: in-process only, `ProjectId`-scoped (never a fs path), KV authoritative, never-truncated recall, single-flight, append-only consolidation, no sidecar / external server.

### Known v0 debt (deferred)
- Graph expansion / temporal knowledge graph (Zep / Graphiti-style entities + edges) — v1.x; needs an extraction LLM + graph storage.
- LLM auto-tagging (`concepts` / `type` on save) — v1.x; would be another silent LLM touch.
- Auto-capture-by-default — **opt-in hooks template only**; never auto-wired (DS-4 / DS-10).
- Auto-install of the Claude Code hooks template (today the user copies the snippet manually).
- Multi-user / org scoping (per-user memory namespaces) — v1.x; v1 is solo power-user.
- Remote sync / cloud memory — never default (violates D6 local+free); a remote *embedding* provider is already opt-in via S6.

## S8 — Bounded model layer (2026-07-25)

**Release-ready.** 340/340 tests green (was 247); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/model`** (9th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model}`). A thin single-shot model **library** — zero MCP tools; consumed in-process by S4 / S7 / S9.
- **`complete(req, cfg)` → `string | object | null`:** one function, 3 adapters (`anthropic` via `@anthropic-ai/sdk` Messages; `openai` via the openai SDK; `openai-compatible` via global `fetch` POST `${baseURL}/chat/completions`, covering Ollama / LM Studio / vLLM with zero extra dep). All adapters use dynamic `import()` + structural typing — import-isolated: a bundle that never selects an adapter ships zero SDK bytes.
- **Structured output:** prompt-based JSON + validate (Zod `.parse` or a caller-supplied function) + at most ONE repair retry (the only retry in the layer).
- **First-class `null` degradation:** no provider ⇒ `null`; missing key ⇒ `null` / `{ok:false}` BEFORE the SDK client is constructed. Full test suite runs offline/free.
- **`model:` config block** on `NoirConfigSchema` (`defaultProvider`, `tiers` draft/title/summarize/consolidate, `providers{name:{model, baseURL?, apiKeyEnv?}}`); `resolveModelConfig` bridge in `@noir-ai/model` (pure projection; no core→model import cycle; stores the env-var NAME, reads the value at call time).

### Changed
- Agent loops are impossible by construction: the `complete` request type has NO `tools` / `stream` parameter (compile-time-enforced).
- Provider resolution is EXPLICIT-only: resolved solely from `req.provider || cfg.defaultProvider`; NEVER inferred from env-var presence; no explicit configured provider ⇒ `null`. The Anthropic/OpenAI SDKs' own env-var fallback can therefore NEVER trigger a paid call.
- SDK `maxRetries: 0` everywhere; transport failures are not retried (the JSON-repair retry is the only retry).

### Security
- Opus final review (0 critical; all blueprint D5 hard rules clean; 2 IMPORTANT — all fixed + tested): (1) `openai-compatible` error `reason` no longer embeds the raw response body (was a prompt/key leak risk on echoing endpoints — NFR-4); (2) the OpenAI adapter now forwards `req.signal` + `maxRetries:0` (bounded wall-clock — NFR-3).

### Known v0 debt (deferred)
- Streaming; tool-calling / agent loops (forbidden by D5 design).
- OS keychain (secrets via env for now).
- Prompt caching (Anthropic `cache_control`).
- Provider-native JSON strict mode (OpenAI `response_format: strict` / Anthropic forced-tool).
- `onUsage` usage sink (fires on success; `noir doctor` wiring deferred).
- Consumer wiring — S4 artifact drafting, S7 consolidation, S9 home help wire `complete()` when consumed; S8 provides the library + config only.
- Real-SDK export-shape drift is unverifiable under offline (fixture-based) CI.

## S6 — Context management (2026-07-25)

**Release-ready.** 247/247 tests green (was 142); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/context`** (8th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context}`). Embedded hybrid retrieval engine that fills S1's declared-but-unused `EmbedFn` seam.
- **Embeddings:** local in-process embedder via `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (384-dim → zero `vec0` migration), loaded lazily through a dynamic import, L2-normalized; model cache at `~/.noir/models/`. Remote (OpenAI / Voyage / Cohere via Matryoshka-384) and Ollama embedders are opt-in and provider-explicit — never the default, never silent.
- **Indexer:** SHA-256 content-hash incremental tracking (on-demand by default; `--watch` opt-in). Markdown-heading chunker for docs; line/token-bounded (~512 tok / 64 overlap) chunker for code. Index-time identifier explosion for BM25 under the `porter` unicode61 tokenizer.
- **Hybrid retriever:** BM25 ∪ kNN fused by Reciprocal Rank Fusion (k=60, rank-based, no score normalization) → token-budget fill → FTS5 windowed snippets (never truncated). BM25-only degraded mode when an embedder is unavailable.
- **MCP tools:** `context_search`, `context_index`, `context_status`, gated on a new `ctx.context` ServerContext service (mirrors `ctx.store` / `ctx.engine`). New `context:` config block on `NoirConfigSchema`; new `packages/daemon/src/context-seam.ts`.
- **Builtin skill `noir-context`** (skills pack now 29 = 17 full + 12 stub).

### Changed
- `Store` interface + impl: added `deleteDoc` / `deleteVec`. New exported `vecAvailability()` native-binary probe centralizes the better-sqlite3 / sqlite-vec availability check (other packages' tests use it instead of importing those natives directly).

### Security
- Opus final review (0 critical, 3 IMPORTANT — all fixed + tested): (1) sensitive-file denylist (`.env`, `*.pem`, keys never indexed); (2) path confinement (rejects `..` / out-of-root traversal); (3) single-flight serialization of concurrent index calls (no orphaned vectors).

### Known v0 debt (deferred)
- Full `.gitignore` parsing (a denylist ships today).
- Tree-sitter symbol-aware code chunking (line/token chunking ships today).
- kNN-only-hit snippet hydration (currently an empty snippet, reported as `mode:'hybrid'`).
- `--watch` full daemon wiring.
- Remote embedding provider SDK completion (current stubs).
- First-run model download (~22 MB, one-time, cached) surfaces an unsupervised network fetch.
