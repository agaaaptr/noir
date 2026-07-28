# Spec — Scaffold Idempotency & Root-Safety (SP-A)

**Date:** 2026-07-26 · **Status:** design (implementation in progress, TDD) · **Slice:** A (first of A→B→C)
**Discovery:** [`docs/internal/discovery/2026-07-26-scaffold-tui-discovery.md`](../discovery/2026-07-26-scaffold-tui-discovery.md) §1.

## Problem (root-caused, confirmed on-disk in the reference project)

`noir init`/`create`/`sync` route through one engine, `scaffold()` in `packages/create/src/scaffold.ts`. `resolveProjectId()` (lines 265–276) mints a **fresh** `project.id` whenever `<root>/.noir/project.id` is absent — and **nothing guards against `root` being (or being inside) a `.noir/` directory**. So invoking Noir while cwd = `.noir/` builds a **nested second project** (`.noir/.noir/`, new id, `.noir/CLAUDE.md`, `.noir/.claude/skills/`, `.noir/.mcp.json`). Reproduced on 1.2.0-beta.2 (two ids `b8b58b86…` / `82ebfbad…`). The initial "not reproducible" audit was a method error (git-only + same-root reasoning).

## Goal

1. Noir **refuses** to scaffold when `root` is — or is inside — a `.noir/` directory (hard safety; the actual duplicate-bug fix).
2. `noir init` at an **already-initialized** root is a safe **no-op** (or `--upgrade`), not a silent re-emit; `--force` re-scaffolds explicitly.
3. `noir doctor` **detects** an existing nested `.noir/.noir/` and offers cleanup.

## Decisions (clarifications, 2026-07-26)

- Baseline 1.2.0-beta.2. Cakupan: engine scaffold (init/create/sync).
- Root-safety is **hard** (no `--force` bypass) — it prevents data corruption, not a preference.
- Already-initialized guard is bypassable via `--force`.
- Non-TTY/CI safe: guards throw/no-op deterministically (no interactive prompt in SP-A; the interactive conflict menu is SP-C).

## Design

### A1. `assertSafeRoot(root)` — root-safety guard (NEW, exported from `@noir-ai/create`)

Called at the top of `scaffold()`, before `readProjectIdFile`. Walks the ancestor chain of `root`; if `root` itself or any ancestor has basename `.noir` → throw a plain `Error` with a clear message ("refusing to scaffold inside `.noir/`; run from the project root"). Plain `Error` → `bin.ts handleError` → exit 1 (consistent with existing init/create error mapping). The walk only goes **up**, so a legitimate `<project>` root that *contains* `.noir/` is never flagged.

### A2. Already-initialized guard (in `scaffold()`)

For `mode === 'init'` and `upgrade !== true`: after `fromVersion = readScaffoldVersion(root)`, if `fromVersion !== null`:
- `opts.force !== true` → emit stderr *"Noir already initialized (scaffold `<v>`). No-op. Use `--upgrade` or `--force`."* and return a no-op `ScaffoldResult` (write nothing).
- `opts.force === true` → proceed (current behavior).
`create` mode: same guard (don't nest into an already-initialized target). `sync`: unchanged (already throws without a valid id). `--dryRun`: report the no-op without writing.

New option on `ScaffoldOptions`: `force?: boolean`. Wired: `bin.ts` adds `--force` to the `init` and `create` commands; `init.ts`/`create.ts` forward it.

### A3. `noir doctor` nested-`.noir` detection

Add a doctor check: if `<root>/.noir/.noir/` exists (and/or `<root>/.noir/{CLAUDE.md,.mcp.json,.claude}`), report *"Detected a nested Noir project inside `.noir/` (likely from running `noir init` inside `.noir/`). Outer id X / nested id Y."* Advisory (status `warn`); offer cleanup interactively in TTY (remove the nested artifacts), report-only otherwise. (Full semantic dedup/consolidation is SP-C; SP-A only handles the structural nested-`.noir` case.)

## Non-goals

- The three-mode writer (regenerate/managedBlock/skipIfExists) is **unchanged**.
- Interactive conflict menu, content-hash dedup, semantic dedup, three-way merge → **SP-C**.
- Banner / home → **SP-B**.

## Testing (TDD)

- `assertSafeRoot`: refuses `…/proj/.noir`, `…/proj/.noir/sub`, `…/proj/.noir/.noir`; allows `…/proj` (even when `…/proj/.noir` exists), `…/proj/sub`.
- `scaffold`: init inside `.noir/` throws (regression for the reported bug); 2nd init at a valid initialized root = no-op (no new writes, no nested id); `--force` re-scaffolds; `--dryRun` reports without writing.
- `noir doctor`: flags a fixture with `.noir/.noir/`.
- Existing init/create/sync tests stay green (byte-identical first-run output preserved).

## Acceptance

- Repro (cwd `.noir/` + `noir init`) now errors clearly instead of nesting.
- Re-init at a valid root = no-op.
- `noir doctor` flags the reference project's nested `.noir`.
- `pnpm build && typecheck && lint && test` green across all packages; no regression in first-run init bytes.

## Impact

Additive, backward-compatible. New `--force` flag (optional). The only behavior change for existing valid flows: a 2nd `noir init` becomes a no-op instead of a silent re-emit (intended; `--force` restores old behavior).
