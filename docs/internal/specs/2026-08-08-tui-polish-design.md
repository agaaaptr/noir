# TUI Polish — Panel component, block cursor, clear screen, fixed-width palette (spec)

> Capability-02 (CLI Runtime & UX) delta — the 1.9.2 TUI redesign left three visual regressions: (1) every surface duplicated `borderStyle="round" borderColor="gray" width={contentWidth()+4}` across 5+ files, (2) the empty command input had no visual indicator of where to type, and (3) entering `noir tui`/`noir palette` left the previous terminal content (banner + home menu) visible above the TUI frame, creating a garbled split screen. The palette's full-width border was also excessively wide.
>
> This spec introduces a shared `<Panel>` component, a block cursor on the empty input field, an ANSI clear-screen on TUI entry, and a fixed-width palette. Internal docs follow `docs/internal/specs/` (no `.superpowers/`).

## Goal

Make the TUI feel **polished and cohesive**:

- **Reusable `<Panel>`** — one component for rounded borders + width accounting; all 5 surfaces (dashboard, palette, home, confirm, search) use it, eliminating duplicated `borderStyle round` props.
- **Fixed-width palette** — the command palette renders inside a ~64-col panel centered in the terminal (like Raycast / VS Code palette), not a full-width wall.
- **Block cursor on empty input** — the command input shows a `▌` cursor at the start even when the buffer is empty, so the user immediately knows where to type.
- **Clear screen on TUI entry** — `noir tui` and `noir palette` emit `\x1b[2J\x1b[H` before mounting, so the terminal is clean (no leftover banner/menu above the dashboard).
- **Cleanup** — remove `.superpowers/` folder (no longer used; the session-starter + task-starter skills are the current context layer).

## Scope

### S1 — Shared `<Panel>` component

`packages/cli/src/tui/Panel.tsx`:

```tsx
interface PanelProps {
  children: ReactNode;
  /** Optional max-width ceiling (e.g. 64 for the command palette). */
  maxWidth?: number;
  /** Additional padding rows above/below content (default none). */
  paddingY?: number;
}
```

- Wraps children in `<Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={...}>`
- Width = `Math.min(contentWidth() + 4, maxWidth ?? Infinity)`
- Default to full terminal width; caps at `maxWidth` when set.

**Consumers (replace inline border Boxes):**

| File | Replacement |
|---|---|
| `App.tsx` dashboard container | `<Panel>` |
| `App.tsx` search output container | `<Panel>` |
| `App.tsx` search query row | `<Panel maxWidth={terminalWidth()}>` (inline) |
| `App.tsx` help container | `<Panel>` |
| `HomeMenu.tsx` container | `<Panel>` |
| `Palette.tsx` container | `<Panel maxWidth={64}>` |
| `Palette.tsx` query row | plain `<Box>` (no nested border — query is inside the panel) |
| `ConfirmOverlay.tsx` | `<Panel>` |

### S2 — Fixed-width palette

`Palette.tsx`:

- Outer `<Panel maxWidth={64}>`
- Query row is a plain `<Box>` (NOT a nested round Box — that produced the `╭╮` inside `╭╮` seen in the bug screenshot). It renders `> query▌` with a dim `▌` cursor.
- Each command label is truncated to `maxWidth - 6` columns (`…` suffix) so no line overflows the fixed panel.
- Section headers (`── recent ──`, `── init ──`) keep their existing style inside the panel.
- The `Header` + `<Panel>` render in a column; the header stays full-width outside the palette panel so the `◆ noir palette` tagline aligns with the terminal edge.

### S3 — Block cursor on empty input

`CommandInput.tsx`:

- When `buffer.length === 0`: render `▌` (dim block) followed by the placeholder text, inside the existing rounded border panel.
- The cursor is static — no blinking (Ink doesn't support timed re-renders for a blink cursor without a state timer; a static `▌` is the standard terminal cursor convention and meets the goal of "user knows where to type").

### S4 — Clear screen on TUI entry

`packages/cli/src/tui/index.tsx`:

- `runTui()`: write `\x1b[2J\x1b[H` to stdout before `render(<App/>)`.
- `runPalette()`: same.
- Ink's `render()` restores the terminal on unmount via its built-in cleanup — no manual restore needed.
- The clear runs BEFORE Ink opens an alternate screen / raw-mode hook, so the frame lands on a clean background.

### S5 — Cleanup `.superpowers/`

- `rm -rf .superpowers/`
- `.superpowers/` was the legacy AI-session scratch directory from superpowers skills. It is no longer in use (session-starter + task-starter + agentmemory are the current context layer). It can contain token-heavy transcripts and plans that drift from the shipped reality.

## Non-goals

- **No blinking cursor** — Ink has no built-in interval re-render primitive; a static `▌` is sufficient.
- **No palette centering** — the palette panel is left-aligned (full-width terminal minus the max-width panel). Centering requires computing horizontal offset manually; the visual result is nearly identical at larger terminal widths.
- **No interactive search filter indicator** beyond the existing `▸` selection prefix + matched-char highlight.
- **No theme/config change** — `borderColor="gray"` stays hardcoded (the `c.dim()` semantic role maps closest to `gray` in Ink's color vocabulary).
- **No TouchBar/special-key handling** — keyboard shortcuts stay exactly as they are.

## Acceptance criteria

1. `<Panel>` is the single source-of-truth for rounded borders — no inline `borderStyle="round"` × `borderColor="gray"` × `width={contentWidth()+4}` left in any component.
2. Palette renders in a ~64-col panel; command labels are truncated to fit; the query row has no nested border.
3. Empty command input shows `▌` cursor before the placeholder text.
4. `noir tui` and `noir palette` clear the terminal before rendering — no leftover home-menu / banner text visible above the TUI frame.
5. `.superpowers/` folder is gone.
6. Full gate green: lint → build → typecheck → test (1539) → docs:validate.
7. Presentational only — no keybinding / routing / logic changes.
