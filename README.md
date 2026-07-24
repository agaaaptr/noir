# Noir

> The discipline, context, and memory layer for any agentic CLI — spec-driven workflow, native working-context, and cross-session memory, local-first by default.

**Noir** is a host-agnostic orchestration layer that makes an agentic CLI (Claude Code is the v1 host; bring-your-own-agent) behave like a disciplined spec-driven engineer. It wires three capabilities every long-running agent loses without help:

1. **Spec-driven workflow** — an escapable, observable lifecycle (idea → spec → plan → implement → verify → document) where every gate decision is recorded.
2. **Native working-context** — a hybrid retrieval engine (BM25 + vector kNN + Reciprocal Rank Fusion) so the host queries small ranked snippets instead of re-reading whole files into its context window.
3. **Cross-session memory** — typed, searchable, governable long-term memory; save an insight in one session and recall it in another.

**Noir is an orchestration layer, NOT an LLM runtime.** It contains no agent loop and no `tools`/`stream` generation surface. The optional model layer is single-shot, provider-explicit, and degrades to pure orchestration when no key is set — it never makes a silent paid call.

## Status

v1.0 is **feature-complete** (slices S0–S9). The current product is the **Noir toolkit** under `packages/`. The older `plugins/noir-workflow/` marketplace plugin (a Claude Code skill pack) is the **predecessor** — still present, but superseded; see [Legacy plugin](#legacy-plugin-predecessor) below.

See [`docs/roadmap.md`](docs/roadmap.md) for the living current-status, and [`docs/specs/2026-07-23-noir-toolkit-design.md`](docs/specs/2026-07-23-noir-toolkit-design.md) for the design blueprint.

## Quick start

```bash
pnpm install
pnpm build          # build all 10 packages

# Initialize a project (scaffolds .noir/ + emits builtin skills + host wiring)
node packages/cli/dist/bin.js init

# Connect a host over MCP (stdio). Claude Code's .mcp.json entry becomes:
#   { "mcpServers": { "noir": { "command": "noir", "args": ["mcp", "serve", "--stdio"] } } }
node packages/cli/dist/bin.js mcp serve --stdio
```

Install the CLI globally (optional) to use `noir` instead of `node packages/cli/dist/bin.js`:

```bash
pnpm --filter @noir-ai/cli build
# then run `noir`, or link/install @noir-ai/cli as you see fit
```

## What's in the box

A pnpm monorepo of **10 packages**, all `@noir-ai/*`:

| Package | Role |
|---|---|
| `@noir-ai/core` | Shared types, config schema (`NoirConfigSchema`), `.noir/` layout, markers. |
| `@noir-ai/store` | Embedded storage: `better-sqlite3` (SQLite) + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN). Project-local DB at `.noir/store/<projectId>.db`; daemon-owned single writer, read-only FS-fallback. |
| `@noir-ai/workflow` | The SDD lifecycle engine — a hand-rolled FSM with observable, escapable gates. State survives daemon restarts. |
| `@noir-ai/skills` | The builtin skill pack (**31 skills: 19 full + 12 stub**) + a copy-and-validate compiler that emits `noir-*` skills to the host. |
| `@noir-ai/context` | Hybrid retrieval engine: local embeddings, markdown/line-token chunker, SHA-256 incremental indexer, BM25 ∪ kNN → RRF → token-budget fill, windowed snippets (never truncated). |
| `@noir-ai/memory` | Cross-session memory layered on the store — save / recall / search / sessions / forget / consolidate, with governance (audit trail, delete-with-reason). |
| `@noir-ai/model` | Optional bounded model layer — single-shot completion, provider-explicit, null-degrades without a key (Anthropic / OpenAI / OpenAI-compatible via fetch). |
| `@noir-ai/daemon` | The runtime authority: owns the store write handle, resolves the embedder once, and exposes the Noir MCP server. |
| `@noir-ai/adapters` | Host abstraction (`HostAdapter`); v1 ships the Claude Code adapter (`.mcp.json` + `CLAUDE.md` @import + `.claude/skills/`). |
| `@noir-ai/cli` | The `noir` command tree (commander + @clack/prompts). |

## The `noir` CLI

Bare `noir` opens an interactive home screen (TTY) or prints `status` (non-interactive).

```
noir init                           scaffold .noir/ + emit builtin skills + host wiring
noir sync                           re-emit skills + host config idempotently
noir status                         probe-only health (works daemon-down; never auto-starts)
noir doctor                         config / store / embedder / native-deps / provider status

noir mcp serve --stdio              serve the Noir MCP server over stdio (how a host connects)
noir daemon start|stop|status|restart   foreground-honest; --detach returns exit 2 (v1.x)

noir context {search,index,status}  store-touching commands are MCP clients to the daemon
noir memory {recall,save,sessions,forget,consolidate}
noir skills {list,sync}
noir task {new,status,advance,next}
```

Global flags: `--json` (machine-readable output), `--no-input` (never prompt), `--quiet`, `--verbose`, `--cwd <dir>`.

## MCP tools

When a host connects via `noir mcp serve`, it gets a curated tool surface:

- **Host:** `host_status`
- **Store:** `store_status`
- **Workflow (4):** `workflow_status`, `workflow_start`, `workflow_advance`, `checkpoint`
- **Context (3):** `context_search`, `context_index`, `context_status`
- **Memory (5 + 1 conditional):** `memory_save`, `memory_recall`, `memory_search`, `memory_sessions`, `memory_forget`, and `memory_consolidate` (registered only when `memory.consolidation.enabled` is on)

## Configuration

Noir reads `.noir/config.yml` (project-local, safe to commit). It defines chunk defaults, embedder/model providers, and the memory consolidation switch. The env-var **name** is stored in config; the **value** is read at call time, so secrets never enter `.noir/config.yml`.

```yaml
# .noir/config.yml (sketch — see NoirConfigSchema for the full shape)
context:
  chunk: { strategy: auto, codeMaxTokens: 512, codeOverlap: 64 }
embedder:
  default: local              # local = offline/private (all-MiniLM-L6-v2, 384-dim)
model:
  defaultProvider: null       # null = pure orchestration, no model calls
  providers: {}
memory:
  consolidation: { enabled: false }   # off by default; never silent
```

## Privacy stance

- **Local-first.** The default embedder runs in-process (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim, L2-normalized) — offline and private. Remote embedders (OpenAI/Voyage/Cohere) and Ollama are opt-in and provider-explicit.
- **Provider-explicit, never silent paid.** The model layer resolves the provider solely from explicit config (`req.provider || cfg.defaultProvider`); it is never inferred from env-var presence. Missing key ⇒ `null` / `{ok:false}` **before** any SDK client is constructed, so the SDKs' own env-var fallbacks can never trigger a paid call. Memory consolidation is opt-in and refuses cleanly (`'no-provider'`) without a provider — no silent LLM consolidation.
- **Project-scoped by canonical ID**, not by filesystem path (paths break across machines).
- **Full governance:** audit trail, delete-with-reason, export.

## Repository structure

```
noir/
├── packages/                the Noir toolkit (10 @noir-ai/* packages)
│   ├── core/ store/ workflow/ skills/
│   ├── context/ memory/ model/
│   └── daemon/ adapters/ cli/
├── plugins/noir-workflow/   PREDECESSOR — the old Claude Code skill-pack plugin (superseded)
├── docs/                     architecture, decisions (ADRs), specs, plans, findings, roadmap, changelog
├── AGENTS.md                 agent guidance for developing this repo
├── biome.json                formatter + linter
└── package.json              pnpm workspace root
```

## Development

```bash
pnpm install
pnpm build          # build all packages
pnpm typecheck      # tsc --noEmit across packages
pnpm lint           # biome check .
pnpm test           # build + vitest run (unit + integration)
```

This repo is itself developed with Claude Code; [`AGENTS.md`](AGENTS.md) holds the conventions.

## Legacy plugin (predecessor)

`plugins/noir-workflow/` is the **older product**: a Claude Code plugin marketplace shipping a `noir-workflow` skill pack (`/init`, `/sync`, `/flow`, `/wrap`, `/checkpoint`). It is the direct ancestor of the toolkit's SDD engine + skill compiler, but is **superseded** — the current product is the `packages/` toolkit above. It remains in-tree for history and for users still on the plugin flow; new users should use `noir init` / `noir sync`.

## Documentation

- [Roadmap & current status](docs/roadmap.md) · [Changelog](docs/CHANGELOG.md)
- [Architecture](docs/architecture/) · [Decision records (ADRs)](docs/decisions/)
- [Design specs](docs/specs/) · [Implementation plans](docs/plans/) · [Validation findings](docs/findings/)

## License

[MIT](LICENSE) — true OSS.
