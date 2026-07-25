# Architecture

Noir is a **host-agnostic orchestration layer** — not an LLM runtime. The host CLI (selected from a `resolveAdapter(host)` registry — Claude Code by default, plus agents-md/gemini/cursor/opencode behind a `HostAdapter`) is the execution engine; Noir is the workflow, context, and memory brain. The two connect over a single MCP server.

## Layered model

```
┌──────────────────────────────────────────────────────────────┐
│  HOST CLI  (Claude Code · Gemini · Cursor · OpenCode · AGENTS.md) │  ← execution engine (BYO-agent)
└───────────▲────────────────────────────────────────▲─────────┘
   MCP tools │              context @import + emitted native skills │
┌────────────┴────────────────────────────────────────┴─────────┐
│  ADAPTER LAYER  — HostAdapter registry: resolveAdapter(host) →     │  ← emits host-native artifacts
│    claude / agents-md / gemini / cursor / opencode                │
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

## The 11 packages (`@noir-ai/*`)

| Package | Responsibility |
|---|---|
| `@noir-ai/core` | Domain types, the `NoirConfigSchema` (zod/v4), `.noir/` path/layout, artifact helpers. No I/O. |
| `@noir-ai/store` | Embedded storage — `better-sqlite3` (SQLite) + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN). Single writer = the daemon; read-only FS-fallback when the daemon is down. |
| `@noir-ai/workflow` | The SDD lifecycle engine — a hand-rolled FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with observable, escapable gates; Full/Quick/Resume modes; state persists in the store so work survives daemon restarts and new sessions. |
| `@noir-ai/skills` | The native builtin skill pack (33 builtins + 1 integration = 34 skills) + a copy-and-validate compiler. Emits `noir-*` `SKILL.md` files to the host. |
| `@noir-ai/context` | Hybrid retrieval: local in-process embeddings (all-MiniLM-L6-v2), markdown/line-token chunker, SHA-256 incremental indexer, BM25 ∪ kNN → Reciprocal Rank Fusion → token-budget fill, windowed snippets (never truncated). |
| `@noir-ai/memory` | Cross-session memory layered on the store (no schema migration): save / recall / search / sessions / forget / consolidate; append-only consolidation; governance (audit, delete-with-reason). |
| `@noir-ai/model` | Optional bounded model layer — one single-shot `complete()` (Anthropic / OpenAI / OpenAI-compatible). No `tools`/`stream`; agent loops impossible by construction; first-class `null` degradation without a key. |
| `@noir-ai/daemon` | The runtime authority: owns the store write handle, resolves the embedder once, and exposes the single Noir MCP server (stdio + Streamable HTTP on 127.0.0.1). |
| `@noir-ai/adapters` | `HostAdapter` interface + a `resolveAdapter(host)` registry over `HostId`. Ships 5 adapters — `claude` (default: `.mcp.json`, managed `CLAUDE.md` @import block, `.claude/skills/`), `agents-md` (universal `AGENTS.md`), `gemini` (`GEMINI.md` + `.gemini/mcp.json`), `cursor` (`.cursor/rules/*.mdc` + `.cursor/mcp.json`), `opencode` (`opencode.json`). A shared `emitAgentsMd(ctx)` helper writes the byte-identical universal `AGENTS.md` every host composes. |
| `@noir-ai/cli` | The `noir` command tree (commander + @clack/prompts); store-touching commands are MCP clients to the daemon. |
| `@noir-ai/create` | The scaffold engine (Slice S): three-mode writer (`regenerate`/`managedBlock`/`skipIfExists`), declarative manifest, `{{var}}` templates, `.noir/scaffold-version`, inline-conflict migrations, read-only stack-detect. Consumed by `noir init`/`sync` and the AI-layer-only `noir create [dir]`. |

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

## Host-agnostic by design — S10 shipped

The host-specific surface is concentrated in one place: the **adapter layer**. A `resolveAdapter(host)` registry (`Record<HostId, HostAdapter>`) maps each host id (`claude` | `agents-md` | `gemini` | `cursor` | `opencode`) to its `HostAdapter`. The CLI's 8 direct `claudeAdapter` imports collapsed to one `resolveAdapter(host)` call; the `host:` config widened from `z.literal('claude')` to the same enum (`claude` is the default — existing projects stay byte-equivalent); and `CompileTarget` widened so the skills compiler transforms per host (e.g. cursor skills compile to flat `.cursor/rules/<name>.mdc`).

**AGENTS.md is the universal baseline.** A shared `emitAgentsMd(ctx)` helper produces byte-identical `AGENTS.md` content for every host — it `@`-imports `.noir/NOIR.md` + `.noir/rules/RULES.md` (the 32-platform standard). Hosts with a native context file (`claude` → `CLAUDE.md`, `gemini` → `GEMINI.md`) keep it as the primary and **do not duplicate** content into `AGENTS.md`; the universal file carries only the canonical `@`-imports. `claude` is the regression anchor: a bare `noir init` is unchanged.

S10 ships 4 new adapters (`agents-md`, `gemini`, `cursor`, `opencode`); `qwen` and `agy` are deferred (the universal `AGENTS.md` covers them in the meantime). Adding a host is now an authoring concern, not an architecture decision: extend `HostId`, author an adapter, register it, and the schema + compiler + `--host` flag widen automatically. The locked decisions live in [ADR-0004](decisions/0004-multi-host-adapters.md); design record [`superpowers/specs/2026-07-25-s10-multihost-design.md`](superpowers/specs/2026-07-25-s10-multihost-design.md).

## v1.x capabilities (added on the beta channel)

Built on one keystone refactor (`managedBlock` + shared `blockWriter` + `HostAdapter` emitters), seven capability slices ship on the beta channel — K/R/I/P/S/X in `v1.1.0-beta.1`, plus **S10 multi-host** and the **S11** SDK/`doctor` remainder in `v1.2.0-beta.1`:

- **K** Keystone — pure refactor: a `managedBlock(name, commentStyle)` factory + shared block-region writer + the `HostAdapter.emitRules` seam that the later slices write through.
- **R** Rules — `.noir/rules/RULES.md` Noir-curated seed wired into `CLAUDE.md` via a managed `RULES_BLOCK`; `noir-rules` skill.
- **I** Ignore — `IgnoreManager` + `syncIgnores` into init/sync (managed-block idempotent across `.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`).
- **P** PRD — `prd` artifact kind + `writePrd`/`readPrd` + `noir-prd` skill (opt-in; no FSM change).
- **S** Scaffold — the `@noir-ai/create` engine (see table above); `noir create [dir]` is AI-layer-only; `noir init --upgrade` runs migrations; `noir doctor` checks scaffold-version drift.
- **X** Integration — first-class integration layer (skill-only / gated-write-proxy / full-runtime tiers). First integration: **ClickUp** (`noir-clickup` skill + `integration.json` + daemon `integrations_auth` / `noir.clickup_write` MCP tools).
- **S10** Multi-host — the adapter registry above; `--host` on `noir init`/`create`/`sync`; `noir doctor` reports the active host. (`v1.2.0-beta.1`.)
- **S11** Distribution + SDK remainder — `docs/sdk.md` (the per-package framework/library API surface) and a `noir doctor` `publish` check (advisory package-metadata validation). (Distribution itself shipped at `1.0.0-beta.1`.)

Full design record: [`specs/2026-07-25-v1x-capabilities-design.md`](specs/2026-07-25-v1x-capabilities-design.md); per-slice specs under [`superpowers/specs/`](superpowers/specs/); the locked decisions in [ADR-0003](decisions/0003-v1x-capabilities.md) (K/R/I/P/S/X) and [ADR-0004](decisions/0004-multi-host-adapters.md) (S10).
