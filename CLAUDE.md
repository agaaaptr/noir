# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

**Noir** is a host-agnostic, spec-driven-workflow + native-context + cross-session-memory **layer** for agentic CLIs — *not* an LLM runtime (bring your own agent). It makes an agentic CLI behave like a disciplined spec-driven engineer: escapable spec→plan→implement→verify lifecycle, hybrid retrieval so the host queries snippets instead of re-reading files, and typed cross-session memory.

- **11 packages** in a pnpm monorepo: `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`.
- **Host-agnostic**: 5 adapters (`claude` default, `agents-md`, `gemini`, `cursor`, `opencode`) via `resolveAdapter(host)`; universal `AGENTS.md` emitter. `claude` is the regression anchor — bare `noir init` is byte-identical.
- **No plugin / marketplace**: ships only native `noir-` builtin skills (+ opt-in integrations like `noir-clickup`). The predecessor `noir-workflow` plugin was removed (see ADR-0002).
- **Local-first**: embedded SQLite store (`better-sqlite3` + FTS5 + `sqlite-vec`), local 384-dim embeddings by default, zero API key required.

## Commands

```bash
pnpm install            # frozen-lockfile in CI
pnpm build              # tsup build all 11 packages (ESM + dts)
pnpm typecheck          # tsc across packages
pnpm lint               # biome check .  (use pnpm format to autofix)
pnpm test               # build + vitest run (offline/free — never needs network or a key)
pnpm docs:validate      # broken links + stale version refs + registry integrity
pnpm docs:generate      # regenerate managed docs blocks + reference docs
```

Run a single test file:

```bash
pnpm vitest run packages/store/test/readonly.test.ts --testTimeout=40000
```

The full gate (what CI enforces, in order): `pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`. **Do not claim a change is done until all five are green.**

## Architecture (big picture)

The core flow: the **CLI** (`@noir-ai/cli`) is the shell entry point → it talks to the **daemon** (`@noir-ai/daemon`) over MCP (stdio or Streamable HTTP) → the daemon owns the **store** (`@noir-ai/store`, single-writer, `ProjectId`-keyed at `.noir/store/<projectId>.db`) → the **workflow** engine (`@noir-ai/workflow`) runs the SDD FSM with observable gates → **context** (`@noir-ai/context`) and **memory** (`@noir-ai/memory`) layer hybrid retrieval (BM25 ∪ kNN → RRF) on top of the store → the optional **model** (`@noir-ai/model`) is a single-shot, provider-explicit completion library (agent loops impossible by construction).

Key invariants to respect:

- **The daemon is the single writer.** Store-touching CLI commands are MCP clients to it (`ensureDaemonRunning` + `@modelcontextprotocol/client`). Never open the store for writes from two processes.
- **`.noir/` is the single source of truth**, keyed by canonical `ProjectId` (never a filesystem path). Generated host artifacts are pointers/transforms, never drifting copies.
- **No silent paid calls.** The model layer resolves the provider ONLY from explicit config (`req.provider || cfg.defaultProvider`), never from env-var presence. No provider/key ⇒ `null`/`{ok:false}` before an SDK client is built. Memory consolidation is gated on `memory.consolidation.enabled` and refuses cleanly without a provider.
- **Agent loops are impossible by construction** — the model request type has no `tools`/`stream` parameter. Tool use lives in the host CLI, not in Noir's model.
- **Provider-explicit + local-first** — remote embedders and model calls are opt-in, never default.

## Conventions

- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`), **commit per scope** (`feat(skills): …`), scope per package.
- **Keep commits local** — push only on explicit user request. Commits stay on `develop` until told otherwise.
- **Test suite runs offline/free** — never add a test that needs a network call or paid key.
- **Docs reflect shipped reality** — when code changes, update the relevant `docs/` at the same checkpoint. No documentation drift.
- **Spec-first for large changes** — brainstorm → spec → plan → implement → review (dogfooded SDD). Specs/plans live in `docs/internal/{specs,plans}`; ADRs in `docs/decisions/`.

## Developer vs agent guidance

- **[`AGENTS.md`](AGENTS.md)** is the authoritative operational manual for developing Noir: toolchain contract, adding a package, the native-skills mechanism, privacy rules, commit discipline. **Read it for any code contribution.**
- **`docs/roadmap/`** is the single source of truth for direction (capability index, status, releases, backlog).
- **Project skills** in `.claude/skills/`: load **session-starter** at the start of a session (global project context: roadmap + memory + knowledge base), and **task-starter** before a task (task-level context). These use the mature plugins (agentmemory, context-mode) as references; Noir itself is not yet initialized in this repo.

## Do not

- Don't reintroduce a plugin / marketplace / `noir-workflow` surface (removed deliberately, ADR-0002).
- Don't commit secrets (API keys, npm tokens) or `.superpowers/` (local session scratch; gitignored).
- Don't push to `main` without explicit go-ahead.
- Don't require `noir init` to have been run in this repo — Noir is not yet mature/initialized here; the plugin stack (agentmemory, context-mode, superpowers) is the current context layer.
