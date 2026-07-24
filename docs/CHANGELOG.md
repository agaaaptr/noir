# Changelog

Notable changes to the Noir toolkit, newest first. Slices follow the roadmap (`docs/roadmap.md`); per-slice design lives in `docs/superpowers/specs/`.

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
