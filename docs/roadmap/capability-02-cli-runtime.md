# Capability 2 — CLI Runtime & User Experience

> **Status:** Partial — a full commander CLI + TUI MVP is shipped; runtime-TUI-as-sole-entry + richer widgets are research

## Overview

The `noir` command-line surface: a Commander command tree with global flags, strict exit-code and stdout/stderr discipline, a bare-`noir` home menu, an Ink TUI dashboard, a scaffold engine, and ignore management. The shipped CLI is far ahead of a research brief — this doc records what exists and the genuine UX gaps.

## Shipped today

- Commander command tree (`packages/cli/src/bin.ts`): `init`, `create [dir]`, `sync`, `mcp serve`, `daemon start|stop|status|restart`, `doctor`, `status`, `context search|index|status`, `memory recall|save|sessions|forget|consolidate`, `skills list|sync`, `task new|status|advance|next`, `install`/`migrate` (C1), `update` (C1), `handoff`, `tui`.
- Global flags on every subcommand: `--json`, `--no-input`, `--quiet`, `--verbose`, `--cwd`, `--tui`/`--no-tui` (advisory), `--no-tips`, `-v`/`--version`.
- S9 exit-code + stream discipline: data → stdout, diagnostics → stderr; color auto-stripped under `--json`/`--quiet`/CI/`NO_COLOR`/non-TTY.
- Bare `noir` home menu (`@clack/prompts` select, `packages/cli/src/commands/home.ts`) when TTY; routes to `status`/`status --json` when non-interactive (probe-only — never auto-starts the daemon).
- `noir tui` Ink dashboard (`packages/cli/src/tui/App.tsx`, React 19 + ink 7), lazy-loaded so React never enters the main CLI startup path (`await import('./tui/…')` only inside the `tui` action, `packages/cli/src/bin.ts`).
- `noir handoff` — pasteable host handoff artifact (never spawns the host).
- Scaffold engine (`packages/create/src/scaffold.ts`): `init`/`create`/`sync` modes, idempotent, scaffold-version stamp + `init --upgrade` migrations, three-mode writer.
- Conflict UX (`packages/cli/src/conflict.ts`, `@clack` resolver), write-path semantic dedup (`packages/cli/src/dedup-write.ts`), ignore management (`packages/core/src/ignore-manager.ts` syncIgnores managed blocks).
- `doctor`: 13 checks including scaffold-version drift, RULES.md budget, host artifacts, publish-readiness, and a C1 **install row** (advisory `ok`/`warn`, never `fail`, no network call — reports detected install method + version + latest-known from the update cache) (`packages/cli/src/commands/doctor.ts`).
- Scriptability: `--json` envelope, `--no-input` never blocks, stable exit codes (0/1/2/3/4/5).

## Gap / roadmap delta

- Daemon backgrounding: `noir daemon start --detach` is wired in `--help` but refused (exit 2, tracked for v1.x) — daemon mode is foreground-only.
- Richer TUI: command palette, searchable command index, history, interactive forms/wizards, in-TUI confirmations. TUI-as-sole-entry is intentionally NOT shipped — the home menu remains the entry point.
- `noir context index --force` not honored.
- `--dry-run`/`--preview` not surfaced on `init`/`create`/`sync`.
- In-process read-only fallback for active commands (`context`/`memory`/`task`) deferred.
- Repo hygiene: `packages/cli/src/bin.ts.bak` stale backup; `bin.ts` comments reference nonexistent `docs/command-policy.md` and `docs/deprecation.md`.

## Acceptance criteria

- [MET] Every command resolves through a single Commander tree with uniform global flags and `--help` output (`packages/cli/src/bin.ts`).
- [MET] Scriptable contract holds: `--json` envelopes on stdout, diagnostics on stderr, `--no-input` never blocks, stable exit codes 0/1/2/3/4/5.
- [MET] `noir tui` launches an Ink dashboard without React in the main CLI startup path; `noir handoff` emits a pasteable artifact without spawning the host.
- [MET] `init`/`create`/`sync` are idempotent with conflict resolution and scaffold-version migration.
- [DONE-CONDITION] `daemon start --detach` backgrounds a daemon and `daemon stop`/`status` manage it over a socket, replacing exit 2 refusal.
- [DONE-CONDITION] `context index --force` forces a rebuild; `--dry-run`/`--preview` on `init`/`create`/`sync` report changes without writing.
- [DONE-CONDITION] TUI gains a command palette / searchable command index while home menu remains the sole entry; no CLI command regresses to interactive-only.

## References

- `packages/cli/src/bin.ts`
- `packages/cli/src/commands/home.ts`
- `packages/cli/src/commands/doctor.ts`
- `packages/cli/src/tui/App.tsx`
- `packages/create/src/scaffold.ts`
- `packages/core/src/ignore-manager.ts`
- `docs/reference/cli.md`
