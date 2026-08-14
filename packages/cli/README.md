# @noir-ai/cli

> The `noir` command-line entry point to the [Noir](../../README.md) AI toolkit — the discipline, context, and memory layer for any agentic CLI.

Noir wires three capabilities every long-running agent loses without help:

1. **Spec-driven workflow** — an escapable, observable lifecycle (idea → spec → plan → implement → verify → document) where every gate decision is recorded.
2. **Native working-context** — hybrid retrieval (BM25 + vector kNN + Reciprocal Rank Fusion) so the host queries small ranked snippets instead of re-reading whole files.
3. **Cross-session memory** — typed, searchable, governable long-term memory; save an insight in one session and recall it in another.

**Noir is an orchestration layer, NOT an LLM runtime** — it contains no agent loop and no `tools`/`stream` generation surface. The optional model layer is single-shot, provider-explicit, and degrades to pure orchestration when no key is set.

## Install

```bash
npm install -g @noir-ai/cli@beta
# or use it on the fly:
npx @noir-ai/cli@beta init
```

Requires Node ≥ 22.

## Quick start

```bash
# 1. Initialize a project (from the project you want Noir to manage)
cd /path/to/your/project
noir init                  # scaffolds .noir/ + host wiring + skills where supported

# 2. Open the project in Claude Code (the default host) → it auto-spawns the Noir MCP server.
```

`noir init` defaults to Claude: it creates `.noir/` (project id, `config.yml`, `NOIR.md`, the SQLite store), root `.mcp.json`, a managed `CLAUDE.md` `@import` block, and the **27 native `noir-*` skills** (26 builtins + 1 integration) in `.claude/skills/`. Pass `--host` for agents-md, Gemini, Cursor, or OpenCode; only Claude and Cursor emit skills. There is no plugin and no marketplace — `noir init` / `noir sync` overwrite the managed `noir-*` namespace idempotently.

## Commands

`noir` (home menu / `status --json`), `status [--json]`, `init`, `create [dir]`, `sync`, `run [prompt...]`, `release [version]`, `mcp serve [--stdio]`, `daemon {start|stop|status|restart}`, `context {search|index|status}`, `memory {recall|save|sessions|forget|consolidate}`, `skills {list|sync|lint|registry}`, `task {new|status|advance|next|decompose|verify|research|research-record|resume|block|abandon}`, `handoff [--write]`, `wrap [--write]`, `install|migrate`, `update`, `tui`, `palette`, `doctor`.

Global flags: `--json`, `--no-input`, `--quiet`, `--verbose`, `--cwd`. Data → stdout, diagnostics → stderr. Exit codes: `0` ok · `1` error · `2` usage · `3` not-found · `4` daemon-down · `5` cancelled.

## The toolkit

This package is the CLI shell. Noir is a pnpm monorepo of 11 `@noir-ai/*` packages: `core`, `store`, `workflow`, `skills`, `daemon`, `adapters`, `cli`, `context`, `model`, `memory`, and `create`.

- **Full toolkit overview:** [root README](../../README.md)
- **Getting-started walkthrough:** [docs/getting-started.md](../../docs/getting-started.md)
- **Command reference:** [docs/reference/cli.md](../../docs/reference/cli.md)
- **Config schema:** [docs/reference/config.md](../../docs/reference/config.md)
- **Roadmap & status:** [docs/roadmap/](../../docs/roadmap/)
- **Releasing (npm token + provenance):** [docs/releasing.md](../../docs/how-to/releasing.md)

MIT © agaaaptr
