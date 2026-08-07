# Home Consolidation + `noir palette` + bidirectional bridge (spec)

> Capability-02 (CLI Runtime & UX) delta — the consolidation that turns bare `noir` into a friendly, organized command-center from which **every** interactive surface is reachable, and bridges the disjoint home-menu ↔ dashboard split that produced the blank-Ctrl+K palette bug (ADR-0006 tracked the TUI delta; this closes the discoverability gap it left).
>
> This is the reference for the implementation plan (`docs/internal/plans/2026-08-06-home-consolidation.md`). Direction: `docs/roadmap/capability-02-cli-runtime.md`.

## Goal

Make `noir` (bare) a **grouped, hint-rich, organized home menu** where a user can:

- reach **every** interactive surface from one entry point (status, context, memory, workflow, setup/maintenance, and the full-screen Ink dashboard);
- navigate smoothly with **back / next / previous** between menu levels (no dead-ends, no trap states);
- discover the full command surface via a new **`noir palette`** fuzzy command palette;
- see a **`──── more ────`** affordance + footer keybinding hints so nothing is hidden;
- and where the **clack menu ↔ Ink dashboard** are bidirectionally cross-linked (menu → dashboard, dashboard → home menu), so the palette-blank confusion is structurally impossible.

All commits stay **local on `develop`** until the publish phase.

## Why (grounded in audit + research)

- **Root cause of the blank-⌘K bug (task #4):** the command palette only exists in `noir tui`. Bare `noir` runs a sparse 8-option @clack menu that (a) has no entry to the dashboard, and (b) @clack's vim-key map makes `Ctrl+K` parse as `name:'k'` → `cursor:up` → highlight drifts toward the bottom "Exit" option. The two interactive surfaces are disjoint with no bridge.
- **The current menu is sparse by the standard of every tool studied** (gh/cli#711, lazygit VISION, k9s, which-key, VS Code palette, Raycast): 8 flat options, no sections, no hints per option, no "there is more" affordance, no dashboard entry. Flat lists > ~7 items overload (Habitat UX, Courier anti-patterns).
- **The codebase already has the hard half of the fix** (all three research lenses converge): `home.ts` owns the correct non-interactive spine; `deps.dispatch` re-parses a fresh commander program (shared with the TUI `/command`); and `buildPaletteCommands(createProgram())` derives every leaf subcommand into a **React-free** `PaletteCommand[]` that `bin.ts` already statically imports (tui/commands/registry.ts). The menu can be enriched as **wiring on top of that registry**, not a second hand-curated table that drifts.
- **Lean-CLI precedent (npm/gh/cargo):** a full-screen Ink dashboard is an opt-in destination reached via a subcommand (`noir tui`); bare invocation stays a lightweight menu. Pulling Ink/React into every `noir` invocation would add startup cost + raw-mode risk (Warp/ConHost) disproportionate for a menu.
- **@clack is pinned ^0.7.0** (verified): no `selectableGroups`, no section headers inside `select`. The 1.x upgrade (autocomplete-in-menu) is a separate, regression-tested effort. We stay on 0.7 and use `selectKey` (section level) + `select` (action level) + `text` (inline args) + `confirm` (destructive gate), composed behind a small state machine in `home.ts`.
  > **Post-1.9.0 fix (2026-08-07):** this assumption was wrong — `selectKey` in @clack 0.7 has no arrow/enter/esc handling and crashes on Enter (`_track=false` → `value=undefined` → `Cannot read properties of undefined (reading 'label')`). The fix upgraded @clack to `^1.7.0` (core 1.4.3) and switched both menu levels to `select`. See CHANGELOG 1.9.1.

## Scope

### S1 — Shared curated-section module (React-free, no-drift)

`packages/cli/src/tui/commands/sections.ts`:

- A `HomeSection[]` definition: each section has `id`, `label`, `hint`, `key` (display-order key, legacy from the original selectKey binding design), and an ordered `items: HomeAction[]`.
- Each `HomeAction` references a palette-registry **`id`** (e.g. `'context search'`) — **not** hand-written argv. At menu build time, `resolveSections(paletteCommands)` filters to ids that exist in the live registry, so a future commander change never crashes the menu (it degrades to what exists).
- `HomeAction` shape: `{ id, label, hint, needsArg?: { prompt, placeholder }, destructive?: boolean, dispatch?: string[] }`. `dispatch` is the argv to run (defaults to the palette entry's `argv`); `needsArg` collects a query/content inline (generalized from today's recall-query).
- **Consumed by both** the clack menu (`home.ts`) and the new TUI home Mode — one command table, two renderers, no drift (this is what makes the blank-palette class of bug structurally impossible).

### S2 — Grouped home menu with back/next/previous navigation

`packages/cli/src/commands/home.ts` (interactive arm only; non-interactive arms + exit-5 unchanged):

- **Level 1 — section picker** (`clack.select`, arrow-navigable; was `selectKey` pre-1.9.1 — post-1.9.0 fix):
  - `1` Status & context · `2` Memory · `3` Workflow · `4` Setup & maintenance · `5` Dashboard (full-screen) · `6` Exit
  - per-option `hint` lists the section's subcommands; arrow navigation, Enter to select, Esc/Ctrl+C to cancel.
- **Level 2 — action list** (per-section `clack.select`, `initialValue` = section top action, per-option `hint` = exact subcommand it runs):
  - each action dispatch through `deps.dispatch` with the argv from the shared section module (or a collected inline arg);
  - **navigation**: `Esc` / backspace / left-arrow → back to the section picker; the state machine supports **next/previous** between sections (right-arrow → next section's action list, left-arrow → previous) so the user can move smoothly without re-entering level 1 each time;
  - **destructive** actions gate behind `clack.confirm` (reusing `isDestructive()` from the palette registry) before dispatch;
  - a `──── more ────` / "All commands (fuzzy palette)" item → dispatches `['palette']` (S3).
- The `Dashboard` section has: **Dashboard** → `['tui']` and **All commands** → `['palette']`.

### S3 — `noir palette` command (Ink palette-first)

`packages/cli/src/bin.ts`:

- New leaf `noir palette`, `requireInteractive`-gated (TTY / `--json` / `--no-input` / CI / NO_COLOR → exit 2), lazy `await import('./tui/…')`, mounts the existing `<Palette>` palette-first via a `{ kind: 'palette' }` initial Mode. Zero new routing.
- `packages/cli/src/tui/index.tsx` gains a `runPalette` export (mirrors `runTui`).

### S4 — TUI home Mode + bidirectional bridge

`packages/cli/src/tui/App.tsx`:

- Add `{ kind: 'home' }` to the `Mode` union as a curated quick-action home rendered in Ink, consuming `sections.ts` (S1), dispatching through the same `dispatchCmd` seam.
- `?` cheatsheet lists **both** dashboard keybindings and home-menu actions (single learnable surface).
- Bridge both ways: menu → `['tui']` (S2) **and** the TUI home Mode is the "return to this menu" half (S4). Palette gains a "Home menu" palette entry (dispatchable).

### S5 — Docs + CHANGELOG

- `docs/reference/cli.md` (regenerate), `docs/getting-started.md` (mention the grouped home + `noir palette`), root `CHANGELOG.md` entry, and `docs/roadmap/` if STATUS/releases mention the TUI delta.

## Non-goals

- **No @clack 1.x upgrade** in this change (autocomplete-in-menu is the single highest-value future consolidation but risks the byte-identical `noir init` anchor — separate, regression-tested effort).
- **No recents in the clack menu** — the menu path stays store-free; recents remain TUI-only (C3 history), per research consensus + user decision.
- **No re-routing**: the non-interactive arms (`menu` / `status --json` / `status`), `--no-input` escape, and exit-5 cancellation are preserved exactly.
- **No Ink in the bare `noir` path** — React/Ink stay out via the two-entry tsup split + lazy import.

## Acceptance criteria

1. Bare `noir` in a TTY shows a **grouped, sectioned** menu (≥5 sections) with per-option hints and a footer hint line.
2. Every interactive surface from the inventory is reachable: **status · context · memory · workflow · setup/maintenance · dashboard · palette · exit** (no omission).
3. Navigation is smooth: **Esc/backspace/← = back**, **→ = next section**, **← = previous section**; no trap states; cancel anywhere → exit 5.
4. **Dashboard** option dispatches `['tui']`; **All commands** dispatches `['palette']`.
5. `noir palette` opens the Ink palette (TTY-gated); the TUI has a **home Mode** and a `?` cheatsheet covering both surfaces.
6. `sections.ts` references only palette ids that exist in the live registry; the menu degrades gracefully (filters) if a command is removed.
7. Non-interactive behavior unchanged (`noir` → `status` / `status --json`; `--no-input`/CI still never prompt; exit-5 on cancel).
8. Full gate green: `pnpm lint → build → typecheck → test → docs:validate`. `noir init` byte-identity preserved.

## Risks

- **Two hops per action** vs the flat 8 → mitigated by `initialValue` = top action and next/previous section navigation. (Pre-1.9.1, the spec relied on `selectKey` for one-key access; post-1.9.0 fix uses `select` for both levels — arrow navigation, Esc→cancel, Enter→submit — so the two-hop overhead is the trade-off for correct behavior.)
- **@clack 1.x upgrade** (post-1.9.0 fix) → upgraded to `^1.7.0` (core 1.4.3). ESM-only matches Noir's module system; `engine >=20.12` satisfied by Noir's `>=22`. The single API break (`validate` receives `string|undefined`) was adapted in `memory.ts`. Esc→cancel is native (via `settings.aliases`).
- **Dispatching `['tui']` from the menu** hands the terminal to Ink mid-run → lazy TUI path + `requireInteractive` already guard raw-mode; verify on Warp/ConHost.
- **New Ink surface (home Mode + `noir palette`)** → must stay on the single root `useInput` + `Mode` union (focus-trapping), or overlays can swallow keys.
- **Unicode glyphs** (⚠/→) must keep ASCII fallback + stay paired with text (theme.ts `badge()` invariant).

---

## Postscript — v1.9.1 fix (2026-08-07)

The spec’s @clack 0.7 + `selectKey` assumption was wrong. `selectKey` in @clack/prompts 0.7 (core 0.3.5) is a *select-by-typed-letter* prompt — no arrow/Enter/Esc handling — and `_track=false` leaves `value` `undefined` until a matching letter is typed. Enter at the Level-1 section picker triggered `state="submit"` → render submit dereferenced `options.find(o => o.value === undefined)` → **`Cannot read properties of undefined (reading 'label')`**.

Fix (CHANGELOG 1.9.1):
- **Upgraded @clack/prompts** `^0.7.0 → ^1.7.0` (core 1.4.3). ESM-only (Noir is ESM). `engine >=20.12` (Noir >=22). Esc → cancel native via `settings.aliases`. Empty-option handling native.
- **Switched both menu levels to `select`** — Level-1 section picker and Level-2 action list now use the same arrow-navigable, Esc-cancelable, Enter-submittable prompt. `selectKey` removed from the home flow.
- **Adapted validate signature** in `memory.ts` (`string → string|undefined` — the sole @clack 1.x API break).
- **Full gate green:** lint, build (11 packages), typecheck, 1539/1539 tests, docs:validate.
