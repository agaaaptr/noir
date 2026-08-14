# Capability 2 — CLI Runtime & User Experience

> **Status:** Completed — a full commander CLI + TUI MVP + the C2 delta (command palette, richer widgets, and the four acceptance-condition gaps) shipped

## Overview

The `noir` command-line surface: a Commander command tree with global flags, strict exit-code and stdout/stderr discipline, a bare-`noir` home menu, an Ink TUI dashboard, a scaffold engine, and ignore management. The shipped CLI is far ahead of a research brief — this doc records what exists and the genuine UX gaps.

## Shipped today

- Commander command tree (`packages/cli/src/bin.ts`): `init`, `create [dir]`, `sync`, `mcp serve`, `daemon start|stop|status|restart`, `doctor`, `status`, `context search|index|status`, `memory recall|save|sessions|forget|consolidate`, `skills list|sync|lint|registry`, `task new|status|advance|next|decompose|verify|research|research-record|resume|block|abandon`, `install`/`migrate` (C1), `update` (C1), `handoff`/`wrap`, `release`, `run` (v2), `tui`, `palette`.
- Global flags on every subcommand: `--json`, `--no-input`, `--quiet`, `--verbose`, `--cwd`, `--tui`/`--no-tui` (advisory), `--no-tips`, `-v`/`--version`.
- S9 exit-code + stream discipline: data → stdout, diagnostics → stderr; color auto-stripped under `--json`/`--quiet`/CI/`NO_COLOR`/non-TTY.
- Bare `noir` home menu (`@clack/prompts` select, `packages/cli/src/commands/home.ts`) when TTY; routes to `status`/`status --json` when non-interactive (probe-only — never auto-starts the daemon).
- `noir tui` Ink dashboard (`packages/cli/src/tui/App.tsx`, React 19 + ink 7), lazy-loaded so React never enters the main CLI startup path (`await import('./tui/…')` only inside the `tui` action, `packages/cli/src/bin.ts`).
- **C2 TUI delta** (ADR-0006): a `Ctrl+K` **command palette** (`packages/cli/src/tui/palette/Palette.tsx`) derived from the commander tree (`commands/registry.ts`), a hand-rolled fuzzy matcher behind a `FuzzyMatcher` swap seam, **input history + recall**, **persistent recent commands** (`~/.noir/<projectId>/tui-history.json` via `atomicWriteFile`, capped + opt-out), **in-TUI destructive confirmation**, and a **searchable output pane** (`Ctrl+F` — folded into the palette `output` corpus in 1.11.0, ADR-0008). App state is a discriminated `Mode` union (`dashboard | palette{corpus} | confirm`).
- `noir handoff` — pasteable host handoff artifact (never spawns the host).
- `daemon start --detach` — **real backgrounding** (`packages/daemon/src/spawn.ts`): spawns a detached child (`detached:true, stdio:'ignore', windowsHide:true` + `unref`), waits for its record + `/health`, writes an honest `mode:'detached'` record. `stop`/`status` unchanged; `probeDaemon` is bounded (`AbortSignal.timeout(1500)`).
- `context index --force` — **forces a full reindex** (the daemon `context_index` tool forwards `force` to the indexer's `reindex()`); default stays incremental.
- `init`/`create`/`sync` — **`--dry-run`/`--preview`** report planned writes without touching disk (reuses the scaffold engine's `dryRun`).
- In-process **read-only fallback** when the daemon is down (`withInProcessRead`): `context search`, `memory recall`/`sessions`, `task status` keep working (reads only — writes stay daemon-gated, single-writer preserved).
- Scaffold engine (`packages/create/src/scaffold.ts`): `init`/`create`/`sync` modes, idempotent, scaffold-version stamp + `init --upgrade` migrations, three-mode writer.
- Conflict UX (`packages/cli/src/conflict.ts`, `@clack` resolver), write-path semantic dedup (`packages/cli/src/dedup-write.ts`), ignore management (`packages/core/src/ignore-manager.ts` syncIgnores managed blocks).
- `doctor`: 13 checks including scaffold-version drift, RULES.md budget, host artifacts, publish-readiness, and a C1 **install row** (advisory `ok`/`warn`, never `fail`, no network call — reports detected install method + version + latest-known from the update cache) (`packages/cli/src/commands/doctor.ts`).
- Scriptability: `--json` envelope, `--no-input` never blocks, stable exit codes (0/1/2/3/4/5).

## Gap / roadmap delta

- **TUI-as-sole-entry is intentionally NOT shipped** — the home menu remains the sole entry point. The **v2 orchestrator TUI** shipped in 1.11.0 (see ADR-0008): single-surface palette consolidation (home/help/search merged into one corpus-aware palette) + `noir run` headless host-driving (stream-json + token/cost + custom `--command` profile). The fullscreen alternate-screen + native-mouse parts of ADR-0006 §6 were **not** shipped (research showed the ecosystem moving to normal-buffer; see ADR-0008).
- **Windows native-install bugs** (C1 debt: win32 `npmBin` computes `npm.exe`; extraction shells out to `unzip`; `install.ps1` lacks auto-PATH/shadow parity; Scoop manifest `bin`) — need a Windows VM to verify.
- **Enhanced standalone conflict menu** (beyond the current `@clack` resolver) — a separate sub-project from the 2026-07-26 discovery. (Three-way managed-region merge via SP-E/SP-H and write-path semantic dedup via `dedup-write.ts` are already shipped above.)

## Acceptance criteria

- [MET] Every command resolves through a single Commander tree with uniform global flags and `--help` output (`packages/cli/src/bin.ts`).
- [MET] Scriptable contract holds: `--json` envelopes on stdout, diagnostics on stderr, `--no-input` never blocks, stable exit codes 0/1/2/3/4/5.
- [MET] `noir tui` launches an Ink dashboard without React in the main CLI startup path; `noir handoff` emits a pasteable artifact without spawning the host.
- [MET] `init`/`create`/`sync` are idempotent with conflict resolution and scaffold-version migration.
- [MET] `daemon start --detach` backgrounds a daemon (detached child + PID record + `/health` boot confirmation) and `daemon stop`/`status` manage it; the record carries an honest `mode:'detached'`.
- [MET] `context index --force` forces a full reindex; `--dry-run`/`--preview` on `init`/`create`/`sync` report changes without writing.
- [MET] TUI gains a command palette (`Ctrl+K`) + searchable output (`Ctrl+F`) + recent-command persistence + in-TUI destructive confirmation, while home menu remains the sole entry; no CLI command regresses to interactive-only.

## References

- `packages/cli/src/bin.ts`
- `packages/cli/src/commands/home.ts`
- `packages/cli/src/commands/doctor.ts`
- `packages/cli/src/tui/App.tsx`
- `packages/create/src/scaffold.ts`
- `packages/core/src/ignore-manager.ts`
- `docs/reference/cli.md`
