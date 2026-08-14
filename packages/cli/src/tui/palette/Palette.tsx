// The single command surface (v2) — presentational renderer.
//
// The App owns the query + active row + the single `useInput` dispatcher; this
// component only paints the rows {@link buildPaletteRows} produced for the
// active corpus (commands / output / help). No `useInput`, no dispatch, no
// history — the App is the sole decision-maker, so home, palette, and typed
// /command all funnel through one seam.

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../../theme.js';
import { LIST_NAV_HINT } from '../hints.js';
import { Panel } from '../Panel.js';
import type { Corpus, PaletteRow } from './rows.js';

const PALETTE_WIDTH = 64;
const VISIBLE_ROWS = 10;

/** The palette's props — supplied by the App (which owns input + dispatch). */
export interface PaletteProps {
  readonly corpus: Corpus;
  readonly query: string;
  readonly active: number;
  readonly rows: readonly PaletteRow[];
}

/** Highlight matched chars of `label` using `matchedIndices` (brand accent). */
function highlight(label: string, matchedIndices: readonly number[]): ReactElement {
  if (matchedIndices.length === 0) return <>{label}</>;
  const set = new Set(matchedIndices);
  const chars: ReactElement[] = [];
  for (let i = 0; i < label.length; i++) {
    const ch = label[i] ?? '';
    chars.push(set.has(i) ? <Text key={i}>{c.accent(ch)}</Text> : <Text key={i}>{ch}</Text>);
  }
  return <>{chars}</>;
}

/** Truncate a label so the fixed-width palette never overflows. */
function truncate(label: string): string {
  const max = Math.max(20, PALETTE_WIDTH - 8);
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Placeholder hint for the query row, per corpus. */
function placeholder(corpus: Corpus): string {
  if (corpus === 'commands') return 'type to search commands';
  if (corpus === 'output') return 'type to filter output';
  return 'keybindings';
}

/**
 * Render the palette overlay: an input row + the corpus list. Presentational —
 * the App owns query/active/input and passes the rows in.
 */
export function Palette({ corpus, query, active, rows }: PaletteProps): ReactElement {
  const visible = rows.slice(0, VISIBLE_ROWS);
  const activeIndex = Math.min(Math.max(active, 0), Math.max(0, visible.length - 1));

  const elements: ReactElement[] = [
    <Box key="header" paddingX={1}>
      <Text>
        {c.bold('▸ palette ')}
        <Text>{c.dim(`(${corpus} · ${visible.length} shown)`)}</Text>
      </Text>
    </Box>,
    <Box key="query" paddingX={1}>
      <Text>
        {c.dim('> ')}
        {query.length > 0 ? query : c.dim(placeholder(corpus))}
        <Text>{c.dim('▌')}</Text>
      </Text>
    </Box>,
  ];

  let lastGroup: string | null = null;
  for (let i = 0; i < visible.length; i++) {
    const row = visible[i];
    if (!row) continue;
    if (row.group !== null && row.group !== lastGroup) {
      elements.push(
        <Box key={`cat:${row.group}`} paddingX={1}>
          <Text>{c.dim(`── ${row.group} ──`)}</Text>
        </Box>,
      );
      lastGroup = row.group;
    }
    const isActive = i === activeIndex;
    elements.push(
      <Box key={row.key} paddingX={1}>
        <Text>
          {isActive ? '▸ ' : '  '}
          {isActive
            ? c.accent(truncate(row.primary))
            : highlight(truncate(row.primary), row.indices)}
          <Text>{c.dim(`  ${row.secondary}`)}</Text>
        </Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column">
      <Panel maxWidth={PALETTE_WIDTH}>{elements}</Panel>
      <Text>{c.dim(LIST_NAV_HINT)}</Text>
    </Box>
  );
}
