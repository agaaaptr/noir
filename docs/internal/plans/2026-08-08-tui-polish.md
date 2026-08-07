# TUI Polish Implementation Plan

> **Goal:** Introduce a shared `<Panel>` component, block cursor on empty input, fixed-width palette, terminal clear on TUI entry, and cleanup `.superpowers/`.

**Architecture:** Single new presentational component (`Panel.tsx`) replaces duplicated `borderStyle="round"` boxes across 5 surfaces. `CommandInput` adds a static `▌` cursor. `runTui`/`runPalette` emit ANSI clear-screen before mount. Palette caps at 64 columns.

**Tech Stack:** Ink 7 (Box, Text), React, TypeScript

## Global Constraints

- Presentational only — no keybinding/routing/logic changes.
- Node ≥22, pnpm, ESM.
- Full gate: lint → build → typecheck → test (1539) → docs:validate.
- Spec: `docs/internal/specs/2026-08-08-tui-polish-design.md`.
- No `.superpowers/`.

---

### Task 1: `.superpowers/` cleanup

**Files:**
- Delete: `.superpowers/` (entire directory)

- [ ] **Step 1: Remove the directory**

```bash
rm -rf .superpowers/
git add -A
git commit -m "chore: remove .superpowers/ (legacy, no longer in use)"
```

---

### Task 2: Create `<Panel>` component

**Files:**
- Create: `packages/cli/src/tui/Panel.tsx`

**Produces:**
```tsx
export function Panel({ children, maxWidth, paddingY }: PanelProps): ReactElement
```

- [ ] **Step 1: Write the component**

```tsx
// packages/cli/src/tui/Panel.tsx
import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { contentWidth } from '../theme.js';

export interface PanelProps {
  readonly children: ReactNode;
  /** Optional max-width ceiling (e.g. 64 for the command palette). */
  readonly maxWidth?: number;
}

/**
 * A rounded-border container used by every TUI surface. Centralizes the
 * width budget (contentWidth + 4 for border + padding) so no caller
 * duplicates `borderStyle round` / `borderColor gray` / `width` math.
 * When `maxWidth` is set the panel caps at that value — used by the
 * command palette for the fixed-width overlay look.
 */
export function Panel({ children, maxWidth }: PanelProps): ReactElement {
  const width = maxWidth != null ? Math.min(contentWidth() + 4, maxWidth) : contentWidth() + 4;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      {children}
    </Box>
  );
}
```

- [ ] **Step 2: Verify typecheck**

```bash
pnpm --filter @noir-ai/cli typecheck
```

---

### Task 3: Wire Panel into home menu

**Files:**
- Modify: `packages/cli/src/tui/HomeMenu.tsx`

**Consumes:** `Panel` from Task 2

- [ ] **Step 1: Replace inline border Box with `<Panel>`**

```tsx
// packages/cli/src/tui/HomeMenu.tsx
// Replace the outer <Box flexDirection="column" borderStyle="round" ...> with <Panel>
import { Panel } from './Panel.js';

// In the return:
<Box flexDirection="column">
  <Panel>
    <Box paddingX={1}>
      <Text>{c.bold('▸ home ')}<Text>{c.dim(`quick actions (${rows.length})`)}</Text></Text>
    </Box>
    {rowsEl.map((row) => (<Box key={row.key} paddingX={1}>{row}</Box>))}
  </Panel>
  <Text>{c.dim('↑/↓ navigate · Enter run · Esc close')}</Text>
</Box>
```

- [ ] **Step 2: Run TUI tests**

```bash
pnpm vitest run packages/cli/test/tui/home-menu.test.tsx
```

---

### Task 4: Wire Panel into dashboard + palette + search + confirm overlay

**Files:**
- Modify: `packages/cli/src/tui/App.tsx`
- Modify: `packages/cli/src/tui/overlays/ConfirmOverlay.tsx`

**Consumes:** `Panel` from Task 2

- [ ] **Step 1: Replace all inline border Boxes in App.tsx**

In `App.tsx`, replace `Box flexDirection="column" borderStyle="round" borderColor="gray" width={contentWidth()+4}` with `<Panel>` in:
- Dashboard container (StatusBar + OutputPane)
- Search output container
- Search query row
- Help container

Also remove `import { contentWidth, divider } from '../theme.js'` for any now-unused imports (keeping `divider`).

```tsx
// Before (dashboard container):
<Box flexDirection="column" borderStyle="round" borderColor="gray" width={contentWidth() + 4}>
  <Box paddingX={1}><StatusBar .../></Box>
  <Box paddingX={1}><Text>{divider()}</Text></Box>
  <Box flexDirection="column" paddingX={1}><OutputPane .../></Box>
</Box>

// After:
<Panel>
  <Box paddingX={1}><StatusBar .../></Box>
  <Box paddingX={1}><Text>{divider()}</Text></Box>
  <Box flexDirection="column" paddingX={1}><OutputPane .../></Box>
</Panel>
```

- [ ] **Step 2: Replace ConfirmOverlay border Box with `<Panel>`**

```tsx
// Before:
<Box borderStyle="round" borderColor="yellow" paddingX={1} width={contentWidth()+4}>
// After:
<Panel>
```

- [ ] **Step 3: Run TUI tests**

```bash
pnpm vitest run packages/cli/test/tui/
```

---

### Task 5: Fixed-width palette

**Files:**
- Modify: `packages/cli/src/tui/palette/Palette.tsx`

**Consumes:** `Panel` from Task 2

- [ ] **Step 1: Wrap list in `<Panel maxWidth={64}>`, remove nested query border**

```tsx
// In Palette.tsx:
import { Panel } from '../Panel.js';
import { contentWidth } from '../../theme.js'; // for label truncation

const PALETTE_WIDTH = 64; // fixed max-width column count

// Query row — plain Box (no nested border):
const queryRow = (
  <Box paddingX={1}>
    <Text>{c.dim('> ')}{query}<Text>{c.dim('▌')}</Text></Text>
  </Box>
);

// Command label truncate helper — cap at PALETTE_WIDTH - 8 (prefix + padding + hint):
function truncateLabel(label: string): string {
  const max = Math.max(20, PALETTE_WIDTH - 8);
  return label.length > max ? label.slice(0, max - 1) + '…' : label;
}

// Outer render: Header outside Panel, list inside Panel
return (
  <Box flexDirection="column">
    <Panel maxWidth={PALETTE_WIDTH}>
      {rows}
    </Panel>
    <Text>{c.dim('↑/↓ navigate · Enter run · Esc close')}</Text>
  </Box>
);
```

- [ ] **Step 2: Run palette tests**

```bash
pnpm vitest run packages/cli/test/tui/palette.test.tsx
```

---

### Task 6: Block cursor on empty input

**Files:**
- Modify: `packages/cli/src/tui/CommandInput.tsx`

- [ ] **Step 1: Add `▌` cursor to empty input**

```tsx
// Before:
if (buffer.length === 0) {
  body = <Text>{c.dim('type a /command ...')}</Text>;
}

// After:
if (buffer.length === 0) {
  body = (
    <Text>
      <Text>{c.dim('▌')}</Text>{' '}
      <Text>{c.dim('type a /command (e.g. /status, /sync, /task next), or q to quit')}</Text>
    </Text>
  );
}
```

- [ ] **Step 2: Verify (TUI tests are regex-based, cursor addition won't break them)**

```bash
pnpm vitest run packages/cli/test/tui/
```

---

### Task 7: Clear screen on TUI entry

**Files:**
- Modify: `packages/cli/src/tui/index.tsx`

- [ ] **Step 1: Emit ANSI clear before render**

```tsx
// In runTui():
export async function runTui(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<void> {
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
  const deps = await buildTuiDeps(opts, dispatch);
  const instance = render(<App deps={deps} />);
  await instance.waitUntilExit();
}

// Same in runPalette():
export async function runPalette(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<void> {
  process.stdout.write('\x1b[2J\x1b[H');
  const deps = await buildTuiDeps(opts, dispatch);
  const instance = render(<App deps={deps} initialMode={{ kind: 'palette' }} />);
  await instance.waitUntilExit();
}
```

- [ ] **Step 2: Verify terminal clear does NOT break Ink rendering**

Ink's `render()` opens its own raw-mode and renders each frame to stdout. The clear-screen bytes are emitted BEFORE Ink takes control of the terminal — they do not interfere with Ink's frame rendering. `waitUntilExit()` restores the terminal on unmount.

```bash
pnpm vitest run packages/cli/test/tui/
```

---

### Task 8: Full gate + commit

- [ ] **Step 1: Run full gate**

```bash
pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(tui): Panel component + block cursor + fixed-width palette + clear screen

- New <Panel> component centralizes rounded border + width accounting;
  all 5 surfaces (dashboard, palette, home, confirm, search) use it.
- CommandInput shows ▌ cursor on empty buffer so the typing position is
  immediately visible.
- Palette renders in a 64-col panel; command labels truncate to fit.
- noir tui / noir palette emit clear-screen ANSI before mounting so
  the terminal is clean (no leftover banner/menu above the frame).
- Removed .superpowers/ (legacy, not in use).

Presentational only — no keybinding/routing/logic changes.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task Dependencies

```
Task 1 (cleanup) ──┐
                    ├── Task 3 (HomeMenu)
Task 2 (Panel) ─────┼── Task 4 (dashboard + confirm)
                    ├── Task 5 (palette)
                    └── Task 6 (cursor) ──┐
Task 7 (clear screen) ────────────────────┤
                                          ├── Task 8 (gate + commit)
```

Tasks 1 + 2 + 6 + 7 are independent (can run in parallel). Tasks 3–5 depend on Task 2.
