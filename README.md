# noir

> A Claude Code plugin marketplace shipping **`noir-workflow`** — a daily, stack-agnostic AI development loop that survives context loss and never acts on assumptions.

`noir-workflow` orchestrates the full lifecycle of a single task — intake, investigation, confirmation, planning, execution, verification, documentation — delegating to specialized plugins when present (else inlining lean phases) and persisting state so work survives context loss. It runs **with or without plugins** (2-mode).

## Why

Two failure modes waste the most time when pair-programming with an agent:

1. **Context loss** — long sessions get summarized; the agent forgets what it was doing.
2. **Assumptions** — the agent acts on a guess instead of confirming, and you discover it three steps later.

This toolkit is built around a single hard rule that addresses both: **Investigate → Confirm → Act**. Nothing executes before facts are gathered *and* you confirm understanding, and every phase is persisted to a state file so the loop can resume anywhere.

## Skills

| Command | What it does |
|---|---|
| `/init` | One-time project bootstrap — detect the real stack, confirm with you, scaffold the standard doc-layout gaps (`docs/{specs,plans,decisions,…}` + `DOC-POLICY.md`, `.session/`, `CLAUDE.md`/`AGENTS.md`), scan existing docs (adapt vs leave), and (if agentmemory) generate a memory-recall doc. |
| `/sync` | Session-start context load (2-mode: index via context-mode, or scan key files) — read git state, recall memory, print an essential-info brief (project type / stack / config). Read-only. |
| `/flow [clickup-id]` | The orchestrated 8-phase loop with review gates. With a ClickUp id → fetch; without → systematic intake template. 2-mode (delegate to Superpowers, or inline lean). Persists state to `workflow/<task>.md`. |
| `/wrap` | Session close — run tests, update docs, curate (built-in tidy), checkpoint, commit, confirm push. |
| `/checkpoint` | Mid-session checkpoint — save progress to `workflow/<task>.md` (+ memory if agentmemory). Resume with `/flow <task>`. |

## How `/flow` works

Eight phases, each pausing for your approval:

```
0 Context → 1 Intake → 2 Investigate → 3 Clarify & Confirm (HARD gate)
         → 4 Plan → 5 Execute → 6 Verify → 7 Document (+ conditional release)
```

`/flow` is a **thin router** in rich mode (delegates Plan/Execute to the Superpowers skills) or **inlines lean phases** when Superpowers is absent. Phase 3 is a hard anti-assumption gate — every open question is resolved with you before any code is touched. Phase 7 commits per scope, **confirms push with you**, and (for Angular FE v13 `@uiigateway/*` libraries) offers a version bump + env-suffixed tag; for auto-deploy backends it skips the tag.

## Repository structure

```
noir/
├── .claude-plugin/marketplace.json   marketplace manifest
├── plugins/noir-workflow/
│   ├── skills/{init,sync,flow,wrap,checkpoint}/  one SKILL.md per skill (+ per-skill references/)
│   ├── references/                   cross-cutting: modes, skill-structure, commit-push, doc-structure
│   └── templates/                    state-file templates
├── AGENTS.md                         agent guidance for developing this repo
└── docs/                             architecture, decisions, specs, plans, findings
```

See [`docs/architecture/`](docs/architecture/) for the full system overview.

## Prerequisites (optional)

The three companion plugins are **optional** — `noir-workflow` runs with or without them (see Two modes below):

| Plugin | Role | If absent |
|---|---|---|
| **Superpowers** | `/flow` delegates plan/execute/debug to its skills. | inline lean phases |
| **context-mode** | JIT retrieval (`ctx_index`/`ctx_search`) — keeps large files out of context. | `Read` + `Grep` |
| **agentmemory** | Cross-session recall/save of durable facts. | native `MEMORY.md` |

## Two modes (rich / lean)

- **Rich** — plugins installed: maximal capability (more tokens).
- **Lean** — no plugins: token-efficient fallbacks, still systematic.
- Default **auto** (each skill probes what is available, per capability). Override in the project's `CLAUDE.md`/`AGENTS.md`:
  ```
  noir-workflow.mode: auto | rich | lean
  ```
- Internals: [`references/modes.md`](plugins/noir-workflow/references/modes.md) · skill authoring [`references/skill-structure.md`](plugins/noir-workflow/references/skill-structure.md) · commit/push [`references/commit-push.md`](plugins/noir-workflow/references/commit-push.md) · doc layout [`references/doc-structure.md`](plugins/noir-workflow/references/doc-structure.md).

## Installation

**Plugin marketplace (primary):**
```
/plugin marketplace add agaaaptr/noir
/plugin install noir-workflow@noir
```

**npx skills (community discoverability):**
```bash
npx skills add agaaaptr/noir
# if it lands in ~/.agents/skills/, symlink:
ln -s ~/.agents/skills/noir ~/.claude/skills/noir
```

**Git clone (fallback):**
```bash
git clone https://github.com/agaaaptr/noir ~/.claude/skills/noir
```

## Configuration (ClickUp — optional, for `/flow`)

`/flow` works **with or without** a ClickUp id (no id → systematic intake template). To fetch a ClickUp task, export in `~/.zshrc` (never commit):
```bash
export CLICKUP_API_TOKEN="pk_..."     # ClickUp → Settings → Apps → Generate
export CLICKUP_TEAM_ID="..."          # only for custom ids like #ABC-123
```
If unset (or no id given), `/flow` uses the intake template — ClickUp is not required.

## Usage

```
/init                      # once per project
/sync                      # at the start of each session
/flow [clickup-id]         # run the loop (id → fetch; no id → intake template)
/checkpoint                # mid-session checkpoint (survives interruption)
/wrap                      # close the session (tests, curate, commit, confirm push)
```

## Noir (toolkit) — developer setup

The Noir CLI lives under `packages/`. From the repo root:

```bash
pnpm install
pnpm build          # build all packages
pnpm test           # vitest (unit + integration)
pnpm lint           # biome
```

Run the CLI locally without a global install:

```bash
node packages/cli/dist/bin.js init          # scaffold .noir/ in cwd
node packages/cli/dist/bin.js mcp serve --stdio
node packages/cli/dist/bin.js daemon start
```

### Noir store

Embedded SQLite (better-sqlite3) with FTS5 (BM25 + window snippets) and sqlite-vec (384-dim kNN). Project-local DB at `.noir/store/<projectId>.db`. The daemon opens the store as the single writer; when the daemon is down, clients fall back to read-only direct access (no migrations). `store_status` MCP tool reports health: `{ok, projectId, docCount, vecCount, dbPath, degraded}`. Tests open the store via `openStore({ projectId, root })` from `@noir-ai/store`.

## Development

This repo is itself developed with Claude Code. [`AGENTS.md`](AGENTS.md) holds the conventions for editing skills safely (SKILL.md format, commit-per-scope, where specs/plans go, how to validate). Edit skills here, then users refresh via `/plugin marketplace update noir` (or `git pull`).

## Known caveats

- **`agentmemory` recall may return empty** in some environments. When it does, `/sync` falls back to `ctx_search` (the context-mode KB) and the native `MEMORY.md`. The durable record for any task is always `workflow/<task>.md`.
- **Non-interactive shell:** the Claude Code Bash tool does not source `~/.zshrc`, so `/flow` phase 1 runs `source ~/.zshrc` to load `CLICKUP_API_TOKEN` (or put exports in `~/.zshenv`, which non-interactive zsh does source).
- **Sparse ClickUp tasks** (empty description) are flagged for clarification at the phase-3 gate — scope is never assumed.

## Documentation

- [Architecture](docs/architecture/) · [Decision records (ADRs)](docs/decisions/)
- [Design specs](docs/specs/) · [Implementation plans](docs/plans/) · [Validation findings](docs/findings/)
