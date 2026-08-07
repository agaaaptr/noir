// Home-consolidation (S4) — the TUI's curated home Mode.
//
// Renders the SAME {@link HomeSection} definitions as the clack home menu
// (tui/commands/sections.ts) as an Ink quick-action list. Arrow keys move the
// active row; Enter runs the selected action through the shared dispatch seam;
// Esc / `h` returns to the dashboard. This is the "return to this menu" half
// of the bidirectional bridge (menu → `noir tui`; TUI → home Mode).
//
// It stays on the App's single-root `useInput` + `Mode` union pattern: this
// component is presentational (like Palette.tsx) and reports its selection via
// `onSelect(action)` — the App owns the dispatch + confirm routing. The list is
// grouped with dim `── section ──` headers (same vocabulary as the palette).

import { Box, Text, useInput } from 'ink';
import { type ReactElement, useState } from 'react';
import { c } from '../theme.js';
import type { HomeAction, HomeSection } from './commands/sections.js';
import { Panel } from './Panel.js';

interface HomeMenuProps {
  /** The resolved sections (from resolveSections). */
  readonly sections: readonly HomeSection[];
  /** Called with a selected action — the App dispatches + records it. */
  onSelect: (action: HomeAction) => void;
  /** Called on Esc / `h` — the App returns to the dashboard. */
  onClose: () => void;
}

/** Flatten sections into `{ section, action }` rows for arrow-key navigation. */
type Row = { section: HomeSection; action: HomeAction };

function flatten(sections: readonly HomeSection[]): Row[] {
  const rows: Row[] = [];
  for (const section of sections) {
    for (const action of section.items) {
      rows.push({ section, action });
    }
  }
  return rows;
}

/**
 * The curated home quick-action list. Arrow keys move the active row (wrapping,
 * clamped), Enter selects, Esc / `h` closes. Every section is shown with a dim
 * header; every action with a one-line hint. The active row is drawn in the
 * brand accent.
 */
export function HomeMenu({ sections, onSelect, onClose }: HomeMenuProps): ReactElement {
  const [active, setActive] = useState(0);
  const rows = flatten(sections);
  const activeRow: Row | undefined =
    rows[Math.min(Math.max(active, 0), Math.max(0, rows.length - 1))];

  useInput((input, key) => {
    if (key.escape || key.tab) {
      onClose();
      return;
    }
    if (key.return) {
      if (activeRow) onSelect(activeRow.action);
      return;
    }
    if (key.upArrow) {
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setActive((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
    // j/k parity (gated: this is the home list, so j/k are navigation here —
    // there is no text buffer on this screen).
    if (input === 'k') {
      setActive((i) => Math.max(0, i - 1));
      return;
    }
    if (input === 'j') {
      setActive((i) => Math.min(rows.length - 1, i + 1));
      return;
    }
  });

  const rowsEl: ReactElement[] = [];
  let lastSectionId: string | null = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue; // defensive: rows is never sparse in practice
    const { section, action } = row;
    if (section.id !== lastSectionId) {
      rowsEl.push(<Text key={`sec:${section.id}`}>{c.dim(`── ${section.label} ──`)}</Text>);
      lastSectionId = section.id;
    }
    const isActive = i === activeRowIndex(active, rows);
    const prefix = isActive ? '▸ ' : '  ';
    rowsEl.push(
      <Text key={action.id}>
        {prefix}
        {isActive ? c.accent(action.label) : action.label}
        <Text>{c.dim(`  ${action.hint}`)}</Text>
      </Text>,
    );
  }

  return (
    <Box flexDirection="column">
      <Panel>
        <Box paddingX={1}>
          <Text>
            {c.bold('▸ home ')}
            <Text>{c.dim(`quick actions (${rows.length})`)}</Text>
          </Text>
        </Box>
        {rowsEl.map((row) => (
          <Box key={row.key ?? 'row'} paddingX={1}>
            {row}
          </Box>
        ))}
      </Panel>
      <Text>{c.dim('↑/↓ navigate · Enter run · Esc close')}</Text>
    </Box>
  );
}

/** Index of the active row (clamped; helper keeps the render DRY). */
function activeRowIndex(active: number, rows: readonly Row[]): number {
  return Math.min(Math.max(active, 0), Math.max(0, rows.length - 1));
}
