# Noir

> The discipline, context, and memory layer for any agentic CLI — spec-driven workflow, native working-context, and cross-session memory, local-first by default.

[![npm](https://img.shields.io/npm/v/@noir-ai/cli?include_prereleases&label=npm)](https://www.npmjs.com/package/@noir-ai/cli)
[![CI](https://github.com/agaaaptr/noir/actions/workflows/ci.yml/badge.svg)](https://github.com/agaaaptr/noir/actions/workflows/ci.yml)
[![Node](https://img.shields.io/node/v/@noir-ai/cli)](https://www.npmjs.com/package/@noir-ai/cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

The `noir` home menu (interactive; `noir status` when non-interactive):

```
$ noir
╭ noir — my-project ──────────────────────────────╮
│                                                  │
◆  What would you like to do?
│  ● Status         project + daemon + store snapshot
│  ○ Index project  (re)index files into context
│  ○ Recall memory  search cross-session memory
│  ○ Next task      suggest next phase + skill
│  ○ Start daemon   foreground daemon
│  ○ Sync skills    re-emit builtin skills
│  ○ Exit
│                                                  │
╰──────────────────────────────────────────────────╯
```

> Run bare `noir` (no arguments) to open this menu. `noir init` is the **scaffold** command — non-interactive; it writes `.noir/` + skills and prints a status line, not this menu.

**Noir** is a host-agnostic orchestration layer that makes an agentic CLI behave like a disciplined spec-driven engineer. **Claude Code is the default host; Gemini, Cursor, OpenCode, and AGENTS.md are one `--host` flag away** (bring-your-own-agent). It wires three capabilities every long-running agent loses without help:

1. **Spec-driven workflow** — an escapable, observable lifecycle (idea → spec → plan → implement → verify → document) where every gate decision is recorded.
2. **Native working-context** — a hybrid retrieval engine (BM25 + vector kNN + Reciprocal Rank Fusion) so the host queries small ranked snippets instead of re-reading whole files into its context window.
3. **Cross-session memory** — typed, searchable, governable long-term memory; save an insight in one session and recall it in another.

**Noir is an orchestration layer, NOT an LLM runtime.** It contains no agent loop and no `tools`/`stream` generation surface. The optional model layer is single-shot, provider-explicit, and degrades to pure orchestration when no key is set — it never makes a silent paid call.

## Status

**1.4.0-beta.1** is the current beta (dist-tag `beta`); stable `1.x` has not been cut yet (the `latest` dist-tag still points at `1.0.0-beta.1`). The beta ships the full v1.x capability set — the keystone refactor (K), five extensions (**R** rules, **I** ignore, **P** PRD, **S** scaffold, **X** integrations), and **multi-host adapters (S10)** — on top of the v1.0 release-ready baseline (slices S0–S9), plus the `1.4.0-beta.1` runtime-polish layer (unified output design-system, idempotent scaffold, universal conflict contract, write-path semantic dedup, TUI runtime policy, `noir handoff`, and the Ink `noir tui` dashboard MVP). Claude Code is the default host; **Gemini, Cursor, OpenCode, and AGENTS.md** (the 32-platform standard) are supported via `--host`. **1315/1315 tests green; 11 packages; 34 skills (33 builtins + 1 integration).**

Noir ships **only native builtin skills (+ opt-in integrations)** — there is no plugin and no marketplace.

See [`docs/roadmap.md`](docs/roadmap.md) for the living current-status, [`docs/specs/2026-07-25-v1x-capabilities-design.md`](docs/specs/2026-07-25-v1x-capabilities-design.md) for the v1.x design record, and [`docs/specs/2026-07-23-noir-toolkit-design.md`](docs/specs/2026-07-23-noir-toolkit-design.md) for the v1.0 design blueprint.

## Installation

Noir ships as the npm package **`@noir-ai/cli`** (bin: `noir`). *Each command below is its own copy-pasteable block — copy the one you want without grabbing the other channel.*

### One-shot (fastest path)

Run Noir once without a global install — `init` the project and exit. Beta channel (`1.4.0-beta.1`):

```bash
npx @noir-ai/cli@beta init
```

Stable:

```bash
npx @noir-ai/cli init
```

Other one-shot runners (drop `@beta` for stable):

```bash
pnpm dlx @noir-ai/cli@beta init
```

```bash
yarn dlx @noir-ai/cli@beta init
```

```bash
bunx @noir-ai/cli@beta init
```

### Global install — npm

Beta:

```bash
npm install -g @noir-ai/cli@beta
```

Stable:

```bash
npm install -g @noir-ai/cli
```

### Global install — pnpm

Beta:

```bash
pnpm add -g @noir-ai/cli@beta
```

Stable:

```bash
pnpm add -g @noir-ai/cli
```

### Global install — yarn (classic)

Beta:

```bash
yarn global add @noir-ai/cli@beta
```

Stable:

```bash
yarn global add @noir-ai/cli
```

### Global install — bun

Beta:

```bash
bun add -g @noir-ai/cli@beta
```

Stable:

```bash
bun add -g @noir-ai/cli
```

### Native installer (`curl | sh`)

A small script that detects Node + npm and runs `npm install -g` on your behalf. Idempotent (re-run = upgrade), prints a PATH hint if `noir` isn't on PATH, and verifies with `noir --version` at the end.

Stable:

```bash
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash
```

Beta channel:

```bash
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_CHANNEL=beta bash
```

Pin a version with `| NOIR_VERSION=1.2.3 bash`. Safer than blind `curl | sh`: `curl -fsSL -o install.sh … && less install.sh && bash install.sh`.

### Homebrew (stable-only)

```bash
brew tap agaaaptr/noir https://github.com/agaaaptr/homebrew-noir
brew install noir
```

Homebrew is stable-only — use npm for the beta channel.

**Requirements:** Node ≥ 22; native deps (better-sqlite3, sqlite-vec, onnxruntime-node) prebuilt on mac/linux/win x64 + arm64; first run downloads ~22 MB MiniLM to `~/.noir/models/`. Verify with `noir --version` / `noir doctor`. Full reference (every path, troubleshooting, the from-source build for repo developers) lives in **[docs/installation.md](docs/installation.md)**.

**Use as a library:** the `@noir-ai/*` workspace packages are also designed to embed — the workflow FSM, hybrid retrieval, cross-session memory, bounded model layer, and scaffold engine are all consumable as libraries. See **[docs/sdk.md](docs/sdk.md)** for the per-package stable API surface.

> **Beta today, stable soon.** `1.4.0-beta.1` is on npm under the `beta` dist-tag (cut from `develop`; stable `1.x` follows once the beta is validated in a real project). `1.0.0-beta.1` was the first publish; `1.1.0-beta.1` added the v1.x capability slices; `1.2.0-beta.1` added multi-host; `1.3.0-beta.6` refined the banner gradient; `1.4.0-beta.1` (current) is the runtime-polish release — unified output design-system (no more red table headers), idempotent scaffold, universal conflict contract, write-path semantic dedup, TUI runtime policy, `noir handoff`, the Ink `noir tui` dashboard MVP, and the CI color fix that unpinned it. (The intermediate `1.3.0-beta.7` / `1.3.0-beta.8` / `1.4.0` tags failed CI and were never published.) Repo developers can also run Noir from source — see [docs/installation.md → From source](docs/installation.md).

## Getting started

Three steps — **install**, **init**, then open the **home menu**:

```bash
npm install -g @noir-ai/cli@beta     # 1. install (one time; puts `noir` on your PATH)
noir init                            # 2. scaffold .noir/ + emit 34 skills + host wiring (non-interactive)
noir                                 # 3. open the home menu (the TUI preview above)
```

`noir init` creates `.noir/` (`project.id`, `config.yml` as `host: claude` + `mode: full`, `NOIR.md`, the SQLite store, `.noir/scaffold-version`, `.noir/rules/RULES.md`), root `.mcp.json`, a managed `CLAUDE.md` `@import` block (plus a managed `RULES_BLOCK`), and the **34 native `noir-*` skills** in `.claude/skills/`. It prints a status line and exits — **non-interactive**. **There is no plugin and no marketplace** — `noir init`/`noir sync` overwrite the `noir-*` namespace idempotently. Then bare `noir` opens the interactive home menu.

`noir init` creates `.noir/` (`project.id`, `config.yml` as `host: claude` + `mode: full`, `NOIR.md`, the SQLite store, `.noir/scaffold-version`, `.noir/rules/RULES.md`), root `.mcp.json`, a managed `CLAUDE.md` `@import` block (plus a managed `RULES_BLOCK`), and the **34 native `noir-*` skills** in `.claude/skills/`. **There is no plugin and no marketplace** — `noir init`/`noir sync` overwrite the `noir-*` namespace idempotently.

**Other hosts:** Noir is cross-CLI. Pass `--host` to target a different agentic CLI — each emits that host's native context/rules/skills/MCP config:

```bash
noir init --host gemini             # GEMINI.md + AGENTS.md + .gemini/mcp.json
noir init --host cursor             # AGENTS.md + .cursor/rules/*.mdc + .cursor/mcp.json
noir init --host opencode           # AGENTS.md + opencode.json
noir init --host agents-md          # AGENTS.md only (the 32-platform universal standard)
```

The chosen host is persisted in `.noir/config.yml`; `noir sync` re-emits for it. See [usage.md → Multi-host](docs/usage.md#multi-host) for the per-host output table.

For the deep, copy-pasteable walkthrough (what each file is, daemon mode, your first session, switching full/quick), see **[docs/getting-started.md](docs/getting-started.md)**.

### Two transports (how the server runs)

- **stdio (default, recommended)** — Claude Code spawns `noir mcp serve --stdio` per session. Zero extra config; the server's lifecycle is the session.
- **daemon (persistent HTTP, opt-in)** — `noir init --transport streamable-http --url http://127.0.0.1:<port>/mcp` + `noir daemon start`. Shared by the host **and** terminal CLI commands; persists across sessions. Killing it while connected breaks the link (no stdio fallback in v1).

### Two SDD modes (discipline level)

- **full (default)** — spec + plan authored **and reviewed**, then execute, then verify. For real features/risky changes.
- **quick** — spec + plan **skipped**, execute, but **verify still fires**. For small/trivial/spike tasks. Override per task: `noir task new --slug <s> --mode quick`.

Transports and modes are **independent** concerns. Full comparison, caveats, the command reference, the config schema, and the `.noir/` + `~/.noir/` layout live in **[docs/usage.md](docs/usage.md)**.

## What's in the box

A pnpm monorepo of **11 packages**, all `@noir-ai/*`:

| Package | Role |
|---|---|
| `@noir-ai/core` | Shared types, config schema (`NoirConfigSchema`), `.noir/` layout, markers. |
| `@noir-ai/store` | Embedded storage: `better-sqlite3` (SQLite) + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN). Project-local DB at `.noir/store/<projectId>.db`; daemon-owned single writer, read-only FS-fallback. |
| `@noir-ai/workflow` | The SDD lifecycle engine — a hand-rolled FSM with observable, escapable gates. State survives daemon restarts. |
| `@noir-ai/skills` | The builtin skill pack (**33 builtins + 1 integration = 34 skills**) + a copy-and-validate compiler that emits `noir-*` skills to the host. |
| `@noir-ai/context` | Hybrid retrieval engine: local embeddings, markdown/line-token chunker, SHA-256 incremental indexer, BM25 ∪ kNN → RRF → token-budget fill, windowed snippets (never truncated). |
| `@noir-ai/memory` | Cross-session memory layered on the store — save / recall / search / sessions / forget / consolidate, with governance (audit trail, delete-with-reason). |
| `@noir-ai/model` | Optional bounded model layer — single-shot completion, provider-explicit, null-degrades without a key (Anthropic / OpenAI / OpenAI-compatible via fetch). |
| `@noir-ai/daemon` | The runtime authority: owns the store write handle, resolves the embedder once, and exposes the Noir MCP server. |
| `@noir-ai/adapters` | Host abstraction (`HostAdapter`) + a `resolveAdapter(host)` registry. Ships 5 adapters — **claude** (default: `.mcp.json` + `CLAUDE.md` @import + `.claude/skills/`), **agents-md** (universal `AGENTS.md`), **gemini** (`GEMINI.md`), **cursor** (`.cursor/rules/*.mdc`), **opencode** (`opencode.json`). |
| `@noir-ai/cli` | The `noir` command tree (commander + @clack/prompts). |
| `@noir-ai/create` | The scaffold engine (Slice S): three-mode writer (`regenerate`/`managedBlock`/`skipIfExists`), declarative manifest, `{{var}}` templates, `.noir/scaffold-version`, inline-conflict migrations, read-only stack-detect. Powers `noir init`/`sync` and `noir create`. |

## The `noir` CLI

**Bare `noir` is the primary UX.** Run it with no arguments: in a TTY it opens the interactive home screen (the menu shown above); in CI, a pipe, or with `--no-input`/`--json`, it prints a `status` snapshot and exits 0 — useful as a no-op health probe, never noisy. Every subcommand below is 100% scriptable and identical in both modes; the menu is just a human shortcut to them.

```
noir init                           scaffold .noir/ + emit builtin skills + host wiring (--host <id> selects the host; default claude)
noir init --upgrade                 run scaffold migrations against an existing .noir/
noir create [dir]                   AI-layer-only scaffold (drop .noir/ + skills, don't touch the rest)
noir sync                           re-emit skills + host config idempotently (cleans stale noir-* dirs)
noir status                         probe-only health (works daemon-down; never auto-starts)
noir doctor                         config / store / embedder / native-deps / provider + scaffold-version + RULES budget

noir mcp serve --stdio              serve the Noir MCP server over stdio (how a host connects)
noir daemon start|stop|status|restart   foreground-honest; --detach returns exit 2 (v1.x)

noir context {search,index,status}  store-touching commands are MCP clients to the daemon
noir memory {recall,save,sessions,forget,consolidate}
noir skills {list,sync}             list shows builtins + integrations (Kind column)
noir task {new,status,advance,next}
```

Global flags: `--json` (machine-readable output, the headless contract), `--no-input` (never prompt), `--quiet`, `--verbose`, `--cwd <dir>`, plus the TUI-policy trio `--tui` / `--no-tui` (advisory routing for bare `noir`) and `--no-tips` (suppress redirect/deprecation hints on stderr). See [docs/command-policy.md](docs/command-policy.md) for the interactive-vs-scriptable matrix and [docs/deprecation.md](docs/deprecation.md) for the deprecation process.

## MCP tools

When a host connects via `noir mcp serve`, it gets a curated tool surface:

- **Host:** `host_status`
- **Store:** `store_status`
- **Workflow (4):** `workflow_status`, `workflow_start`, `workflow_advance`, `checkpoint`
- **Context (3):** `context_search`, `context_index`, `context_status`
- **Memory (5 + 1 conditional):** `memory_save`, `memory_recall`, `memory_search`, `memory_sessions`, `memory_forget`, and `memory_consolidate` (registered only when `memory.consolidation.enabled` is on)
- **Integrations (Slice X):** `integrations_auth` (resolves an integration token env-var server-side at call time) and per-integration gated-write proxies — e.g. `noir.clickup_write` (HARD confirm gate, endpoint allowlist, id-charset validation, 429 backoff, audit JSONL). Registered only for integrations whose `integration.json` declares `runtime` other than `none`.

## Native builtin skills

**The builtin skills ARE the only skills.** There is no plugin to install and no marketplace to add — Noir ships a pack of **34 native `noir-` skills** (33 builtins + 1 integration) in the Claude Code `SKILL.md` format. `noir init` / `noir sync` discover, compile, and emit them idempotently to the host's `.claude/skills/` via the `@noir-ai/skills` compiler; the `noir-*` namespace is managed and overwritten on every sync.

The pack spans the SDD lifecycle, power/session/git/domain skills, and utils (e.g. `noir-brainstorm`, `noir-spec`, `noir-plan`, `noir-execute`, `noir-review`, `noir-recall`, `noir-remember`, `noir-context`, `noir-commit`, `noir-pr`, …). Each skill's YAML `description` states **WHEN** to trigger (a leading cue like "Use when…"), never WHAT it does — so the host loads the body on demand instead of following a shortcut. Adding a skill is authoring a folder under `packages/skills/builtin/` (see [AGENTS.md](AGENTS.md)).

## Configuration

Noir reads `.noir/config.yml` (project-local, safe to commit). It defines chunk defaults, embedder/model providers, and the memory consolidation switch. The env-var **name** is stored in config; the **value** is read at call time, so secrets never enter `.noir/config.yml`.

```yaml
# .noir/config.yml (sketch — see NoirConfigSchema in @noir-ai/core for the full shape)
host: claude                 # claude (default) | agents-md | gemini | cursor | opencode
mode: full                   # full | quick — the SDD discipline level
daemon: { idleTimeoutSec: 900, port: 0 }
context:                     # local-first retrieval (S6)
  embedder: { kind: local, dim: 384 }   # local = offline/private (MiniLM-L6-v2); remote/ollama opt-in
  budgetTokens: 4096
model: {}                    # empty = pure orchestration (no model calls); provider-explicit when set
memory:
  consolidation: { enabled: false }      # off by default; opt-in + provider-explicit, never silent
```

## Privacy stance

- **Local-first.** The default embedder runs in-process (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim, L2-normalized) — offline and private. Remote embedders (OpenAI/Voyage/Cohere) and Ollama are opt-in and provider-explicit.
- **Provider-explicit, never silent paid.** The model layer resolves the provider solely from explicit config (`req.provider || cfg.defaultProvider`); it is never inferred from env-var presence. Missing key ⇒ `null` / `{ok:false}` **before** any SDK client is constructed, so the SDKs' own env-var fallbacks can never trigger a paid call. Memory consolidation is opt-in and refuses cleanly (`'no-provider'`) without a provider — no silent LLM consolidation.
- **Project-scoped by canonical ID**, not by filesystem path (paths break across machines).
- **Full governance:** audit trail, delete-with-reason, export.

## Repository structure

```
noir/
├── packages/                the Noir toolkit (11 @noir-ai/* packages)
│   ├── core/ store/ workflow/ skills/ create/
│   ├── context/ memory/ model/
│   └── daemon/ adapters/ cli/
├── scripts/                  install.sh (native installer), bump-version.mjs (release versioning)
├── packaging/homebrew/       Homebrew formula + tap material
├── .github/workflows/        ci.yml, release.yml (npm automation token + provenance)
├── docs/                     architecture, decisions (ADRs), specs, roadmap, changelog
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

## Documentation

- **[Installation](docs/installation.md)** — every install path (native installer, npm/pnpm/yarn/bun, npx, Homebrew), troubleshooting, requirements.
- **[Getting started](docs/getting-started.md)** · **[Usage reference](docs/usage.md)** — transports, SDD modes, commands, config.
- **[Command policy](docs/command-policy.md)** · **[Deprecation policy](docs/deprecation.md)** — the interactive-vs-scriptable contract (TUI runtime) and the warn→redirect→never-silently-remove process.
- **[Releasing](docs/releasing.md)** · **[Adding a package](docs/packaging.md)** — the npm publish runbook (automation token + provenance, beta/stable channels), and how to add an `@noir-ai/*` package.
- [Roadmap & current status](docs/roadmap.md) · [Changelog](docs/CHANGELOG.md)
- [Architecture](docs/architecture/) · [Decision records (ADRs)](docs/decisions/)
- [Design blueprint](docs/specs/2026-07-23-noir-toolkit-design.md) · [SDD spec/plan history](docs/superpowers/)

## License

[MIT](LICENSE) — true OSS.
