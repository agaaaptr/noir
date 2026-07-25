# @noir-ai/cli

> The `noir` command-line entry point to the [Noir](../../README.md) AI toolkit — the discipline, context, and memory layer for any agentic CLI.

Noir wires three capabilities every long-running agent loses without help:

1. **Spec-driven workflow** — an escapable, observable lifecycle (idea → spec → plan → implement → verify → document) where every gate decision is recorded.
2. **Native working-context** — hybrid retrieval (BM25 + vector kNN + Reciprocal Rank Fusion) so the host queries small ranked snippets instead of re-reading whole files.
3. **Cross-session memory** — typed, searchable, governable long-term memory; save an insight in one session and recall it in another.

**Noir is an orchestration layer, NOT an LLM runtime** — it contains no agent loop and no `tools`/`stream` generation surface. The optional model layer is single-shot, provider-explicit, and degrades to pure orchestration when no key is set.

## Install

```bash
npm install -g @noir-ai/cli
# or use it on the fly:
npx @noir-ai/cli init
```

Requires Node ≥ 20.

## Quick start

```bash
# 1. Initialize a project (from the project you want Noir to manage)
cd /path/to/your/project
noir init                  # scaffolds .noir/ + emits 31 builtin skills + host wiring

# 2. Open the project in Claude Code (the v1 host) → it auto-spawns the Noir MCP server.
```

`noir init` creates `.noir/` (project id, `config.yml`, `NOIR.md`, the SQLite store), root `.mcp.json`, a managed `CLAUDE.md` `@import` block, and the **31 native `noir-*` skills** in `.claude/skills/`. There is no plugin and no marketplace — `noir init` / `noir sync` overwrite the `noir-*` namespace idempotently.

## Commands

`noir` (home menu / `status --json`), `status [--json]`, `init`, `sync`, `mcp serve [--stdio]`, `daemon {start|stop|status|restart}`, `context {search|index|status}`, `memory {recall|save|sessions|forget|consolidate}`, `skills {list|sync}`, `task {new|status|advance|next}`, `doctor`.

Global flags: `--json`, `--no-input`, `--quiet`, `--verbose`, `--cwd`. Data → stdout, diagnostics → stderr. Exit codes: `0` ok · `1` error · `2` usage · `3` not-found · `4` daemon-down · `5` cancelled.

## The toolkit

This package is the CLI shell. Noir is a pnpm monorepo of 10 `@noir-ai/*` packages: `core`, `store`, `workflow`, `skills`, `daemon`, `adapters`, `cli`, `context`, `model`, `memory`.

- **Full toolkit overview:** [root README](../../README.md)
- **Getting-started walkthrough:** [docs/getting-started.md](../../docs/getting-started.md)
- **Command reference + config schema:** [docs/usage.md](../../docs/usage.md)
- **Roadmap & status:** [docs/roadmap.md](../../docs/roadmap.md)
- **Releasing (OIDC + provenance):** [docs/releasing.md](../../docs/releasing.md)

MIT © agaaaptr
