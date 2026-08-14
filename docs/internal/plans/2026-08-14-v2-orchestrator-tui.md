# Plan — v2 Orchestrator TUI implementation

- **Date:** 2026-08-14
- **Spec:** [`2026-08-14-v2-orchestrator-tui-design.md`](../specs/2026-08-14-v2-orchestrator-tui-design.md)
- **Discovery:** [`2026-08-14-v2-orchestrator-tui-discovery.md`](../discovery/2026-08-14-v2-orchestrator-tui-discovery.md)

> **⚠️ Shipped-shape reconciliation — ADR-0008 is the authoritative record.** Slice 3 (streaming pipeline) and the StatusBar/transcript-picker parts of Slice 4/5 were **not** delivered as specified: the orchestrator shipped as the `noir run` CLI command (module at `src/orchestrator.ts`, not `tui/` + `tui/host-command.ts`), `capture.ts` was kept for the in-process `/command` dispatch (no `tui/stream.ts`), and the custom host command is a per-invocation `--command` flag (not persisted). The "Definition of done" items about removing `capture.ts` and building `tui/stream.ts`/`tui/host-command.ts` are superseded by ADR-0008.

## Slices (in dependency order)

### Slice 1 — Unified recents + dead-weight cleanup (foundation)
- **Files:** `tui/palette/history.ts`, `tui/hooks/useInputBuffer.ts`, `tui/commands/registry.ts`, `tui/commands/sections.ts`, `tui/palette/types.ts`.
- Generalize `loadRecent`/`recordRecent` as the single recents source; wire shell recall to read it.
- Drop `HomeSection.key`, stale `['context','forget']`, redundant `PaletteCommand.keywords`.
- **Tests:** update `tui/history.test.ts`, `tui/sections.test.ts`, `tui/registry.test.ts`, `tui/useInputBuffer.test.tsx`.
- **Gate:** `pnpm vitest run packages/cli/test/tui/`.

### Slice 2 — Surface consolidation (merge home/help/search → palette)
- **Files:** `tui/App.tsx`, `tui/palette/Palette.tsx`, `tui/palette/types.ts`, delete `tui/HomeMenu.tsx` + `tui/overlays/SearchMode.ts`, `tui/Footer.tsx`.
- Collapse `Mode` to `dashboard | palette{corpus} | confirm`; single `useInput`; corpus switch `Tab`; `?`→help corpus, `Ctrl+F`→output corpus, `h`→home corpus; confirm gates all dispatch paths; shared footer constant.
- Move `computeMatches` into the palette module.
- **Tests:** update `tui.test.tsx`, `tui/palette.test.tsx`, `tui/search.test.tsx`, `tui/home-menu.test.tsx`.
- **Gate:** full `packages/cli` test dir.

### Slice 3 — Streaming pipeline (replace `capture.ts`)
- **Files:** new `tui/stream.ts`, rewrite `tui/capture.ts` → delete, update `tui/App.tsx` dispatch runner + `OutputPane`.
- `spawnStream` + ring buffer + throttled flush + phase enum; `<Static>` for completed output.
- **Tests:** new `tui/stream.test.ts`.
- **Gate:** full `packages/cli` test dir + `pnpm build` (tsup) + `pnpm typecheck`.

### Slice 4 — Orchestrator (spawn host + stream-json + custom command + reducer)
- **Files:** new `tui/orchestrator.ts` (+ `tui/host-command.ts` for the custom-command config), `tui/App.tsx` wiring, extend `tui/StatusBar.tsx`.
- `resolveHostCommand` precedence; spawn with host flags; `HostAdapter` normalization seam; `max-usage-per-message.id` reducer; token/cost accumulator.
- **Tests:** new `tui/orchestrator.test.ts` (reducer + host-command + normalization fixtures).
- **Gate:** full `packages/cli` test dir + build + typecheck.

### Slice 5 — Token/cost status line + transcript
- **Files:** `tui/StatusBar.tsx`, `tui/App.tsx`, transcript picker (palette corpus).
- Single-line token/cost bar (model | $ | context-% | tokens), throttled ~300 ms, "API-equivalent estimate" label.
- Transcript mode: session picker corpus over the normalized event log.
- **Tests:** extend `tui` component tests + `StatusBar` unit test.
- **Gate:** full gate `lint → build → typecheck → test → docs:validate`.

### Slice 6 — Docs sync + release
- Update `docs/roadmap/` (STATUS, releases, backlog, manifest), `capability-02`, CHANGELOG, add ADR for the form-factor reversal (hybrid over fullscreen).
- Bump version, beta tag, merge main, stable tag, Homebrew/Scoop bump (per CLAUDE.md patch-release flow).

## Testing strategy
- TDD per slice: write/update the failing test first, then the implementation, then green.
- Offline/free only — no network, no paid key (repo invariant).
- Regression anchors: every existing `packages/cli/test/tui/*` test is updated, not deleted, so the consolidation is behavior-preserving where intended and explicit where not.

## Rollback
- Each slice is a self-contained commit; if a slice breaks the gate, revert that slice's commit and re-run before continuing.
- `develop` is the working branch; nothing pushes until the full gate is green and the user approves.

## Definition of done
1. All five gates green (`pnpm lint` → `pnpm build` → `pnpm typecheck` → `pnpm test` → `pnpm docs:validate`).
2. No `HomeMenu.tsx`, `overlays/SearchMode.ts`, or `capture.ts` remain; no dead fields.
3. All roadmap docs + CHANGELOG + capability-02 + ADR reflect shipped reality.
4. `develop == main` after the release sync.
