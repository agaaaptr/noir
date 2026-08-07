# Getting started

> The first-use walkthrough: install Noir, initialize a project, connect your host, and run your first spec-driven session. Concrete commands throughout.

New to Noir? Read the [README](../README.md) first for the 30-second "what and why," then come back here. For the full reference (every command, the config schema, the filesystem layout), see [CLI Reference](reference/cli.md).

## What you need

- **No system Node prerequisite** if you use the native installer (recommended) — it provisions a managed Node 22.x runtime under `~/.noir/`. If you install via npm/pnpm/yarn/bun directly, **Node.js ≥ 22** is required (Node 22 is what CI uses). For the from-source dev install below you also need **pnpm 10** (`corepack enable && corepack prepare pnpm@10 --activate`).
- **An agentic CLI host.** Noir targets **Claude Code by default**; Gemini, Cursor, OpenCode, and AGENTS.md are supported via `noir init --host <id>` (see [usage.md](reference/cli.md#multi-host)). This walkthrough uses Claude Code. Noir is the workflow/context/memory *layer* — it is not an agent runtime. **Bring your own agent.**
- macOS, Linux, or Windows on x64 or arm64 (native deps ship prebuilt).

## Install

### Recommended: native installer

For end users the install is one line. The installer provisions a managed Node 22.x runtime under `~/.noir/` (no system Node, no `sudo`/admin), installs `@noir-ai/cli` into an isolated prefix, and writes a `noir` shim at `~/.noir/bin/noir`:

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | bash
# Windows (PowerShell — no Git Bash/MSYS2/WSL needed)
powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.ps1 | iex"
```

Two channels ship in parallel:

<!-- noir:doc:status -->
**Latest stable:** `1.9.2` (npm dist-tag `latest` — `npm i @noir-ai/cli` resolves here)
**Current beta:** `1.9.2-beta.1` (npm dist-tag `beta` — `npm i @noir-ai/cli@beta` to opt in)
**Source version:** `1.9.3` (clean SemVer in `packages/*/package.json`)

*Last auto-generated: 2026-08-07T10:03:46.793Z*
<!-- /noir:doc:status -->

- **Beta** — `@noir-ai/cli@beta`. Set `NOIR_CHANNEL=beta` (POSIX) or `$env:NOIR_CHANNEL='beta'` (PowerShell):

  ```bash
  curl -fsSL https://raw.githubusercontent.com/agaaaptr/noir/main/scripts/install.sh | NOIR_CHANNEL=beta bash
  ```

- **Pin a version** — `NOIR_VERSION=<VERSION>` (e.g. `1.6.0`) overrides the channel.

The installer is idempotent (re-run = upgrade), prints a PATH hint if `noir` isn't on PATH, and verifies with `noir --version` at the end. To move an existing npm/Homebrew/Scoop install to the native path, run `noir migrate` (settings preserved). To update later, run `noir update`. The full reference — npm/pnpm/yarn/bun, one-shot `npx`, Homebrew, Scoop, troubleshooting, the **beta vs stable** channel model, and the trust/checksum/attestation story — lives in **[installation.md](how-to/installation.md)**.

### From source (repo developers only)

If you're developing Noir itself rather than using it, install from source: `git clone`, then `pnpm install && pnpm build`, then put `noir` on PATH via `pnpm --filter @noir-ai/cli link --global`. The `.mcp.json` written by `noir init` calls `command: "noir"`, so Claude Code needs `noir` resolvable on PATH. Full from-source walk-through (native deps, the first-run model download, the PATH papercut): **[installation.md](how-to/installation.md)**. End users should ignore this path and use the native installer or npm.

## Initialize a project

From the root of the project you want Noir to manage:

```bash
noir init
```

`noir init` is idempotent and safe to re-run. It scaffolds the per-project `.noir/` directory and emits the host wiring. Specifically it creates:

| Path | What it is |
|---|---|
| `.noir/project.id` | A UUID — the project's canonical `ProjectId` (Noir keys everything on this, never on a filesystem path). |
| `.noir/config.yml` | Project config. Starts as `host: claude` + `mode: full`. See [configuration](reference/cli.md). |
| `.noir/NOIR.md` | The canonical context file. The host merely `@import`s it. |
| `.noir/rules/RULES.md` | The Noir-curated rules seed (Slice R); wired into the host context file via a managed `RULES_BLOCK`. |
| `.noir/scaffold-version` | The scaffold-engine version stamp; `noir doctor` reports drift, `noir init --upgrade` runs migrations. |
| `.mcp.json` | The MCP server entry Claude Code reads. |
| `CLAUDE.md` | A managed `@import ".noir/NOIR.md"` block is inserted (existing content is preserved). |
| `.claude/skills/noir-*` | The **34 native `noir-` skills** (33 builtins + 1 integration) are compiled and emitted here. |

`.noir/store/` (the SQLite DB), `.noir/specs/`, `.noir/plans/`, `.noir/tasks/`, `.noir/decisions/`, and `.noir/audit/` are created on demand as you work.

> **No plugin, no marketplace.** Noir ships only its native `noir-` builtins. There is nothing to install into the host — `noir init`/`noir sync` overwrite the `noir-*` namespace idempotently.

## Connect your host over MCP

The Noir MCP server runs in one of **two transport modes**. This is about *how the server process runs* — it's a separate concern from the SDD discipline level (full/quick) covered later. `noir init` defaults to the one almost everyone should use.

### Default: stdio (recommended)

This is the zero-config path. `noir init` (no flags) writes a `.mcp.json` that points Claude Code at a stdio server:

```json
{
  "mcpServers": {
    "noir": { "command": "noir", "args": ["mcp", "serve", "--stdio"] }
  }
}
```

**Steps:**

1. `noir init` (default transport is `stdio`).
2. Open the project in **Claude Code**. That's it — Claude Code auto-spawns `noir mcp serve --stdio` and connects.
3. The server's lifecycle **is** the Claude Code session: when you close the session, the server goes with it. No separate process to manage.

This is the right choice for almost everyone. Use the daemon only if you need the extras below.

### Optional: daemon (persistent HTTP)

The daemon is a **long-lived** Noir server that multiple clients can share — the host *and* terminal CLI commands (`noir context search`, `noir task new`, …) all talk to the same process, and it persists across host sessions.

**Steps:**

1. Initialize for the HTTP transport, pinning a localhost port:

   ```bash
   noir init --transport streamable-http --url http://127.0.0.1:8787/mcp
   ```

2. Set the **same** port in `.noir/config.yml` so CLI commands find the daemon:

   ```yaml
   daemon:
     port: 8787
   ```

3. Start the daemon (it runs in the **foreground**):

   ```bash
   noir daemon start
   # foreground mode (backgrounding deferred); Ctrl+C to stop
   ```

4. Open the project in Claude Code. It connects to `http://127.0.0.1:8787/mcp` via `.mcp.json`.

**Caveats (v1):**

- Killing the daemon while the host is connected **breaks the connection** — there is **no auto-fallback to stdio** in v1. Your data stays durable on disk, and reads have a degraded read-only fallback, but the live host link is severed until you restart the daemon.
- The daemon is **foreground by default**; pass `--detach` to fork a detached child that persists after the parent exits (`noir daemon start --detach` reports the child's PID and port). Auto-restart daemons are v1.x.
- A single global `~/.noir/daemon.json` records the running daemon; running Noir concurrently in two projects on the same machine will clobber that record (per-project records are v1.x).

Pick the daemon **only** if you need a persistent shared server across host sessions. Active terminal commands start a daemon when needed; otherwise, stdio is the simplest host transport. See [transports](explanation/sdd-workflow.md#transports) for the full comparison.

## Your first session in Claude Code

You work **through** the host. After `noir init` and opening the project in Claude Code, just ask it to build something — for example, *"add a CSV export to the reports module."* The native skills pick up the request and run Noir's spec-driven lifecycle:

```
noir-brainstorm  →  noir-intake  →  noir-clarify  →  noir-spec
   →  noir-plan  →  noir-execute  →  noir-verify  →  noir-document
```

- `noir-execute` uses `context_search` to pull focused, ranked snippets instead of re-reading whole files, and `memory_recall` for anything you saved in a prior session.
- `noir-document` ends with `memory_save`, so insights carry into the next session.
- **Every gate decision is recorded** in `.noir/audit/`. State persists to the project-local store, so a new session can resume a task where the last one left off.

You can watch the lifecycle from a terminal at any time:

```bash
noir status         # probe-only health; works even with the daemon down
noir task status    # where the active task is in the lifecycle
noir doctor         # config / store / embedder / native deps / provider / install status
```

`noir doctor` includes an **install row** (advisory `ok`/`warn`, never `fail`, no network call) that reports the detected install method (`native`/`npm`/`pnpm`/…), the installed version, and the latest-known version from the update cache — a non-blocking `native recommended` nudge appears when you're on a non-native path.

That's the whole loop. You don't drive the gates by hand — you talk to the host, and the host drives Noir.

## Browsing commands (home + palette)

You don't need to memorize every subcommand. Two surfaces make discovery effortless:

- **Bare `noir`** (no arguments) opens a **grouped home menu** — a section picker (Status &amp; context / Memory / Workflow / Setup &amp; maintenance / Dashboard) then per-section action lists with hints and destructive-action confirmation. Use `↑/↓` and `1`–`6` to navigate; `Esc` steps back; `→`/`←` moves between sections.
- **`noir palette`** opens a **fuzzy command palette** (Ink) — type to filter any command, `↑/↓` to choose, `Enter` to run. `Esc` closes.
- **`noir tui`** opens the full-screen **Ink dashboard** (live status, `/command` input, `Ctrl+K` palette, `Ctrl+F` find-in-output, `h` for the curated quick-actions home screen, `?` cheatsheet).

From the home menu, select **Dashboard (full-screen)** to launch the TUI, or **All commands** to open the fuzzy palette. The two surfaces are cross-linked — the bridge works both ways.

## Switching discipline: full vs quick

Separate from the transport, every task runs at a **discipline level** — `full` or `quick`. Set the default in `.noir/config.yml` (`mode: full` is the default after `noir init`), or override it per task:

```bash
noir task new --slug csv-export --mode quick
```

- **full** — spec + plan are authored **and reviewed** (gates), then execute, then verify (tests/build). Use this for real features and risky changes. This is the default.
- **quick** — spec + plan are **skipped** (a `<quick-mode stub spec>` is written, and the spec/plan gates are recorded as `skipped`), execute runs, and the **verify gate still fires**. Use this for small, trivial, or spike tasks. It is not a free-for-all — it only skips formal planning, not verification.

The host picks up the configured mode via the `noir-intake` skill / the `workflow_start` MCP tool. See [SDD modes](explanation/sdd-workflow.md#modes) for the details.

## Where to go next

- [installation.md](how-to/installation.md) — the full install reference (every path, troubleshooting, the channel model).
- [usage.md](reference/cli.md) — the full reference: every command, the config schema, the `.noir/` + `~/.noir/` layout, and the privacy rules.
- [architecture/README.md](explanation/architecture.md) — how the 11 packages fit together (incl. the v1.x capability slices).
- [roadmap/](roadmap/) — project direction, capability index, releases & version targets.
