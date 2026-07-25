# Usage reference

> The reference for using Noir: the two transports, the two SDD modes, every CLI command, the config schema, the filesystem layout, and the privacy rules. For a first-use walkthrough, see [getting-started.md](getting-started.md).

Noir is a **host-agnostic orchestration layer** — not an LLM runtime. You work *through* a host CLI (Claude Code in v1); Noir is the workflow, context, and memory brain, connected over a single MCP server. **Bring your own agent.**

---

## Transports

The Noir MCP server runs in one of two transport modes. This governs **how the server process runs** — it is independent of the SDD discipline level (full/quick).

| | **stdio** (default, recommended) | **daemon** (persistent HTTP, opt-in) |
|---|---|---|
| How it runs | Claude Code spawns `noir mcp serve --stdio` per session | A long-lived `noir daemon start` process on `127.0.0.1:<port>` |
| Lifecycle | Tied to the Claude Code session | Persists across host sessions |
| Config | Zero — `noir init` writes `.mcp.json` | Pin the same port in `.noir/config.yml` (`daemon.port`) and in `--url` |
| Shared by CLI? | No (CLI store-touching commands need the daemon) | Yes — host **and** `noir context`/`memory`/`task` share one server |
| Setup effort | None | A few steps + a process to keep running |
| When to use | Almost everyone | Persistent shared server, or terminal CLI access alongside the host |

### stdio (default)

```bash
noir init          # writes the stdio .mcp.json below
```

```json
{
  "mcpServers": {
    "noir": { "command": "noir", "args": ["mcp", "serve", "--stdio"] }
  }
}
```

Open the project in Claude Code → it auto-spawns the server → connected. No separate process; the server's lifecycle is the Claude Code session.

> From-source users: `.mcp.json` calls `command: "noir"`, so Claude Code needs `noir` on PATH. Run `pnpm --filter @noir-ai/cli link --global`, or edit `.mcp.json` to invoke `node packages/cli/dist/bin.js` instead. (Goes away with `npx noir` in S11.)

### daemon (persistent HTTP)

```bash
# 1. init for HTTP on a fixed localhost port
noir init --transport streamable-http --url http://127.0.0.1:8787/mcp

# 2. set the SAME port in .noir/config.yml
#    daemon:
#      port: 8787

# 3. start the daemon (foreground)
noir daemon start

# 4. open the project in Claude Code — it connects to that URL
```

Daemon commands:

```bash
noir daemon start      # foreground; --detach returns exit 2 in v1
noir daemon stop
noir daemon status     # pid / port / uptime / mode, or "not running" (exit 4)
noir daemon restart
```

**Caveats (v1):**

- Killing the daemon while the host is connected **breaks the connection** — there is **no auto-fallback to stdio** in v1. Data stays durable on disk; reads degrade to a read-only FS fallback, but the live host link is severed until restart.
- The daemon is **foreground-only** (`--detach` is honestly unimplemented, exit 2). Backgrounded / auto-restart is v1.x.
- One global `~/.noir/daemon.json` records the running daemon; concurrent Noir projects on the same machine clobber it (per-project records are v1.x).

---

## SDD modes: full vs quick

Every task runs at a discipline level — `full` or `quick`. This governs **which gates fire**, not how the server runs.

| | **full** (default) | **quick** |
|---|---|---|
| Spec + plan | Authored **and reviewed** (gates) | **Skipped** — a `<quick-mode stub spec>` is written; spec/plan gates recorded as `skipped` |
| Execute | Runs | Runs |
| Verify | Fires (tests/build) | **Still fires** |
| Use for | Real features, risky changes | Small, trivial, spike tasks |

Quick mode is **not** a free-for-all — it skips formal *planning*, not *verification*.

### Setting the mode

**Per-project default** — `.noir/config.yml`:

```yaml
mode: full      # or: quick   (full is the default after `noir init`)
```

**Per-task override:**

```bash
noir task new --slug csv-export --mode quick
noir task new --slug refactor-auth --mode full
```

The host (Claude Code) picks up the configured mode via the `noir-intake` skill / the `workflow_start` MCP tool. Each gate decision is recorded in `.noir/audit/<taskId>.json`, so a new session can resume a task where the last one left off.

---

## Command reference

Bare `noir` opens an interactive home screen (TTY) or prints `status` (non-interactive / `--json`).

### Global flags

| Flag | Effect |
|---|---|
| `--json` | Emit machine-readable JSON to stdout |
| `--no-input` | Never prompt; error if input is required |
| `--quiet` | Suppress non-essential diagnostics |
| `--verbose` | Show additional diagnostic detail |
| `--cwd <path>` | Run as if started in `<path>` |

These parse in any position (`noir --json status` and `noir status --json` both work) and apply to subcommands. Data goes to **stdout**; diagnostics go to **stderr**.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | OK |
| `1` | Error |
| `2` | Usage (bad flags / input) |
| `3` | Not found |
| `4` | Daemon down |
| `5` | Cancelled |

### The command tree

| Command | What it does |
|---|---|
| `noir init` | Scaffold `.noir/` + emit the 31 builtin skills + write host wiring (`.mcp.json`, `CLAUDE.md` @import). Flags: `--transport stdio\|streamable-http` (default `stdio`), `--url <url>` (required for HTTP, localhost only). |
| `noir sync` | Re-emit skills + host config idempotently (the `noir-*` namespace is overwritten). |
| `noir status` | Probe-only health check. **Works daemon-down; never auto-starts the daemon.** |
| `noir doctor` | Report config / store / embedder / native-deps / provider status (no live model call). |
| `noir mcp serve [--stdio]` | Serve the Noir MCP server over stdio (this is how a host connects). |
| `noir daemon start` | Start the daemon in the foreground (`--detach` → exit 2 in v1). |
| `noir daemon stop` | Stop the running daemon. |
| `noir daemon status` | Report daemon liveness (pid/port/uptime/mode), or "not running" (exit 4). |
| `noir daemon restart` | Stop then start. |
| `noir context search` | Hybrid-retrieve (BM25 ∪ vector kNN → RRF) ranked snippets. |
| `noir context index` | (Re)index configured roots (SHA-256 incremental). |
| `noir context status` | Doc/vec counts, embedder mode, indexing state. |
| `noir memory recall` | Recall saved observations (hybrid retrieval, hydrated from KV). |
| `noir memory save` | Save a typed observation (prompts for content/type unless `--no-input`/`--json`). |
| `noir memory sessions` | List recent sessions. |
| `noir memory forget` | Delete observations (governed: delete-with-reason, audited). |
| `noir memory consolidate` | Append-only LLM consolidation → derived `lesson` observations. **Refuses cleanly without an enabled provider; never silent.** |
| `noir skills list` | List the emitted builtin skills. |
| `noir skills sync` | Re-emit the skill pack to `.claude/skills/`. |
| `noir task new` | Start a workflow task. Flags: `--slug <s>` (required; doubles as the task id), `--mode full\|quick`. |
| `noir task status` | Where the active task is in the lifecycle (phase / state / mode). |
| `noir task advance` | Advance the active task. Flags: `--to <phase>`, `--force <reason>`. |
| `noir task next` | Show the next gate / action for the active task. |

Store-touching commands (`context`, `memory`, `task`) are **MCP clients to the daemon** — they need a running daemon (stdio or HTTP). `status` is the only probe-only command that works daemon-down.

### MCP tools (what the host sees)

When a host connects via `noir mcp serve`, it receives a curated tool surface:

- **Host / Store:** `host_status`, `store_status`
- **Workflow:** `workflow_status`, `workflow_start`, `workflow_advance`, `checkpoint`
- **Context:** `context_search`, `context_index`, `context_status`
- **Memory:** `memory_save`, `memory_recall`, `memory_search`, `memory_sessions`, `memory_forget`, and `memory_consolidate` (registered **only** when `memory.consolidation.enabled` is on)

---

## Configuration

Noir reads `.noir/config.yml` (project-local, safe to commit). It is validated by `NoirConfigSchema` (zod/v4); every block has a default, so a config with only `host` + `mode` parses and behaves as local-first / fully-degraded (offline, free). The **env-var name** is stored in config; the **value** is read at call time, so secrets never enter this file.

### Full schema

```yaml
# .noir/config.yml
host: claude                  # the only host in v1 (HostAdapter; more in S10)
name: my-project              # optional, informational
mode: full                    # full | quick — the default SDD discipline level

daemon:
  idleTimeoutSec: 900         # daemon idle auto-stop (foreground in v1)
  port: 8787                  # optional; pin for the HTTP transport so CLI + host agree

context:
  embedder:
    kind: local               # local (default, offline) | remote | ollama | none
    model: Xenova/all-MiniLM-L6-v2   # HF repo id (local) / provider model id (remote) / Ollama tag
    provider: openai          # remote provider key (openai/voyage/cohere); remote only
    baseURL: http://localhost:11434   # Ollama base URL; ollama only
    dim: 384                  # MUST be 384 to match the vec0 table
  roots: []                   # index roots (informational; daemon/indexer consume)
  budgetTokens: 4096          # default token budget for a context_search result set

model:                        # OPTIONAL — omit entirely for pure orchestration (no model calls)
  defaultProvider: anthropic  # fallback provider key into providers{} when a tier has none
  tiers:                      # per-tier provider-key overrides
    draft: anthropic
    title: openai
    summarize: anthropic
    consolidate: anthropic
  providers:
    anthropic:
      model: claude-3-5-sonnet-latest
      apiKeyEnv: ANTHROPIC_API_KEY    # the env-var NAME, not the value
    openai:
      model: gpt-4o-mini
      apiKeyEnv: OPENAI_API_KEY
    ollama:                    # anonymous local provider — omit apiKeyEnv
      model: qwen2.5:7b
      baseURL: http://localhost:11434/v1

memory:
  consolidation:
    enabled: false            # master switch (default false). The FIRST gate.
    provider: anthropic       # provider key; required alongside enabled
    model: claude-3-5-sonnet-latest   # consumed by the model layer
    types: [pattern, bug]     # optional: restrict candidates to these types
```

### Privacy + provider-explicit rules

These are load-bearing invariants, not preferences. Any change to Noir must honor them.

- **Local-first by default.** The default embedder runs in-process (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim, L2-normalized) — offline and private. Remote embedders (OpenAI/Voyage/Cohere) and Ollama are **opt-in** and provider-explicit (`kind: remote`/`ollama`). First run downloads the ~22 MB model once to `~/.noir/models/`.
- **Provider-explicit — never a silent paid call.** The model layer resolves the provider **solely** from explicit config (`req.provider || cfg.defaultProvider`). It is **never** inferred from env-var presence — `ANTHROPIC_API_KEY` being set for another tool does **not** activate Anthropic in Noir. No explicit, configured provider ⇒ `complete()` returns `null` **before** any SDK client is constructed, so the SDKs' own env-var fallbacks can never trigger a paid call.
- **Secrets live in env vars only.** `apiKeyEnv` stores the env-var **name** (e.g. `ANTHROPIC_API_KEY`), never the value. `.noir/config.yml` is safe to commit and share.
- **No provider ⇒ degrade, don't fail.** Without an explicit provider, `complete()` returns `null` and callers substitute a template/stub — Noir keeps working as pure orchestration. The full test suite runs offline/free.
- **Consolidation is opt-in.** Memory consolidation is gated on its own `memory.consolidation.enabled` master switch **and** a provider. `enabled: false` (the default) ⇒ the `memory_consolidate` tool is unregistered and `noir memory consolidate` refuses with `'no-provider'` and makes **no** model call. Capture, store, and retrieve are always local and free.
- **Project-scoped by canonical `ProjectId`**, never by filesystem path (paths break across machines).
- **Full governance** over memory: audit trail, delete-with-reason, export.

---

## Filesystem layout

### `.noir/` (per-project)

The project's single source of truth, keyed by a canonical `ProjectId`. Generated host artifacts are pointers/transforms of `.noir/`, never drifting copies.

| Path | Purpose |
|---|---|
| `.noir/project.id` | The canonical `ProjectId` (UUID). |
| `.noir/config.yml` | Project config (see above). Safe to commit. |
| `.noir/NOIR.md` | Canonical context file; the host `@import`s it. |
| `.noir/store/<projectId>.db` | The project-local SQLite DB (FTS5 + sqlite-vec). **Gitignore this.** |
| `.noir/specs/` | Authored specs (SDD). |
| `.noir/plans/` | Authored plans (SDD). |
| `.noir/tasks/` | Task records. |
| `.noir/decisions/` | Decision stubs. |
| `.noir/audit/` | Per-task gate decisions (`<taskId>.json`). |
| `.noir/intake/` | Intake notes (SDD). |

### `~/.noir/` (per-user global)

| Path | Purpose |
|---|---|
| `~/.noir/daemon.json` | The singleton daemon record (`{pid, port, startedAt}`). Clobbers under concurrent projects in v1. |
| `~/.noir/models/` | The embedder model cache (~22 MB `all-MiniLM-L6-v2`, downloaded once). |

---

## See also

- [getting-started.md](getting-started.md) — the first-use walkthrough.
- [architecture/README.md](architecture/README.md) — how the 10 packages fit together.
- [roadmap.md](roadmap.md) — v1.0 vs v1.x (distribution / `npx` / more hosts are S10–S11).
- [AGENTS.md](../AGENTS.md) — guidance for developing Noir itself.
