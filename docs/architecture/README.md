# Architecture

Noir is a **host-agnostic orchestration layer** — not an LLM runtime. The host CLI (Claude Code in v1, behind an abstract `HostAdapter`) is the execution engine; Noir is the workflow, context, and memory brain. The two connect over a single MCP server.

## Layered model

```
┌──────────────────────────────────────────────────────────────┐
│  HOST CLI  (Claude Code · …S10 adds Gemini/OpenCode/Agy/Qwen) │  ← execution engine (BYO-agent)
└───────────▲────────────────────────────────────────▲─────────┘
   MCP tools │              context @import + emitted native skills │
┌────────────┴────────────────────────────────────────┴─────────┐
│  ADAPTER LAYER  — HostAdapter (v1: claudeAdapter)               │  ← emits host-native artifacts
├────────────────────────────────────────────────────────────────┤
│  NOIR CORE  (CLI-agnostic)                                     │
│   Workflow Engine · Context Engine · Memory Engine ·           │
│   Bounded Model Layer · Skills Compiler · Daemon + MCP server  │
├──────────────────────────────────────────────────────────────── ┤
│  `noir` CLI  (commander + @clack/prompts; thin daemon client)  │  ← user-facing
└────────────▲───────────────────────────────────────────────────┘
             │  single source of truth
   .noir/ (project, ProjectId-keyed)        ~/.noir/ (user-global: models, daemon record)
```

## The 10 packages (`@noir-ai/*`)

| Package | Responsibility |
|---|---|
| `@noir-ai/core` | Domain types, the `NoirConfigSchema` (zod/v4), `.noir/` path/layout, artifact helpers. No I/O. |
| `@noir-ai/store` | Embedded storage — `better-sqlite3` (SQLite) + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN). Single writer = the daemon; read-only FS-fallback when the daemon is down. |
| `@noir-ai/workflow` | The SDD lifecycle engine — a hand-rolled FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with observable, escapable gates; Full/Quick/Resume modes; state persists in the store so work survives daemon restarts and new sessions. |
| `@noir-ai/skills` | The native builtin skill pack (31 skills) + a copy-and-validate compiler. Emits `noir-*` `SKILL.md` files to the host. |
| `@noir-ai/context` | Hybrid retrieval: local in-process embeddings (all-MiniLM-L6-v2), markdown/line-token chunker, SHA-256 incremental indexer, BM25 ∪ kNN → Reciprocal Rank Fusion → token-budget fill, windowed snippets (never truncated). |
| `@noir-ai/memory` | Cross-session memory layered on the store (no schema migration): save / recall / search / sessions / forget / consolidate; append-only consolidation; governance (audit, delete-with-reason). |
| `@noir-ai/model` | Optional bounded model layer — one single-shot `complete()` (Anthropic / OpenAI / OpenAI-compatible). No `tools`/`stream`; agent loops impossible by construction; first-class `null` degradation without a key. |
| `@noir-ai/daemon` | The runtime authority: owns the store write handle, resolves the embedder once, and exposes the single Noir MCP server (stdio + Streamable HTTP on 127.0.0.1). |
| `@noir-ai/adapters` | `HostAdapter` interface + emitters. v1 ships `claudeAdapter` (`.mcp.json`, managed `CLAUDE.md` @import block, `.claude/skills/`). |
| `@noir-ai/cli` | The `noir` command tree (commander + @clack/prompts); store-touching commands are MCP clients to the daemon. |

## How a host connects

A host connects to Noir the same way every host will — over **MCP**:

1. `noir init` scaffolds `.noir/` (config, store) and emits the native skill pack + host wiring (for Claude Code: a `.mcp.json` pointing at `noir mcp serve --stdio`, plus a managed `CLAUDE.md` `@import` of `.noir/NOIR.md`).
2. The host spawns `noir mcp serve --stdio` (or talks to the long-lived daemon over HTTP). It receives a curated tool surface: `host_status`, `store_status`, `workflow_*`, `checkpoint`, `context_*`, and `memory_*`.
3. The host agent then calls those tools as it works — `context_search` for focused snippets, `memory_save`/`memory_recall` for cross-session continuity, `workflow_*`/`checkpoint` for lifecycle state.

The daemon is the **single writer** to the store; if it is down, reads (FTS/kNN/counts/state) keep working in read-only FS-fallback and `noir status` reports `degraded` honestly.

## The `.noir/` portable store

`.noir/` is the project's single source of truth, keyed by a **canonical `ProjectId` — never a filesystem path** (paths break across machines). It holds `config.yml`, `NOIR.md` (the canonical context file the host merely `@import`s), the ProjectId-keyed SQLite DB, and SDD artifacts (`intake/`, `specs/`, `plans/`, `tasks/`, `decisions/`, `audit/`, `CHANGELOG.md`). `~/.noir/` holds user-global concerns (the embedder model cache, the singleton daemon record). Generated host artifacts are pointers/transforms of `.noir/`, never drifting copies.

## Privacy + provider-explicit stance

- **Local-first.** The default embedder runs in-process (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim) — offline and private. Remote embedders (OpenAI/Voyage/Cohere) and Ollama are opt-in, provider-explicit, never default.
- **Never a silent paid call.** The model layer resolves the provider solely from explicit config (`req.provider || cfg.defaultProvider`); it is never inferred from env-var presence. Missing key ⇒ `null` / `{ok:false}` **before** an SDK client is constructed, so the SDKs' own env-var fallbacks can never trigger a paid call. Memory consolidation is opt-in (`memory.consolidation.enabled`) and refuses cleanly without a provider.
- **Full governance** over memory: audit trail, delete-with-reason, export.

## Governing principles

1. **One CLI-agnostic core; hosts are thin targets** — never fork logic per host.
2. **`.noir/` is the single source of truth** — generated artifacts are pointers/transforms, never copies that drift.
3. **The daemon is the runtime authority** — the CLI and hosts are clients.
4. **MCP = dynamic intelligence; static artifacts = declarative context/skills.**
5. **Graceful degradation everywhere** — no key → pure orchestration; daemon down → read-only store; host lacks a feature → emulate.

## Host-agnostic by design → S10

The only host-specific assumption in v1 is `claudeAdapter` + the Claude-only skills `CompileTarget`. S10 widens both: an adapter registry (`resolveAdapter(host)`), `host` config beyond `z.literal('claude')`, and per-host compile targets. That is the **single gate** to cross-CLI — the architecture is built so generalization is mechanical, not a rewrite.
