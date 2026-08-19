// The single command surface (v2) — presentational renderer.
//
// The App owns the query + active row + the single `useInput` dispatcher; this
// component only paints the rows {@link buildPaletteRows} produced for the
// active corpus (commands / output / help). No `useInput`, no dispatch, no
// history — the App is the sole decision-maker, so home, palette, and typed
// /command all funnel through one seam.
//
// Layout (two-column, per the v2 design): a fixed label column (bold) on the
// left, a dim hint column on the right. For command rows the hint is the
// command's argv (short + unambiguous); the FULL description is shown as a
// wrapped detail line on the ACTIVE row only, so it is never truncated. The
// active row is highlighted with reverse video (SGR 7) — visible on any
// terminal, not just color ones.

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../../theme.js';
import { LIST_NAV_HINT } from '../hints.js';
import { Panel } from '../Panel.js';
import { type Corpus, type PaletteRow, VISIBLE_ROWS } from './rows.js';

const PALETTE_WIDTH = 64;
/** Border + padding overhead between the panel width and a row's text budget:
 *  round border (2) + Panel paddingX (2) + row paddingX (2) = 6. A row's
 *  label(26) + hint must never exceed the remaining width or Ink wraps the
 *  hint tail onto a flush-left second line (the v1.11.2 two-column bug). */
const ROW_TEXT_WIDTH = PALETTE_WIDTH - 6; // 58
/** Fixed label column: the `▸ `/`  ` prefix (2) + the label. */
const LABEL_WIDTH = 26;
/** Max hint column width — derived from the row budget so the two-column row
 *  can never overflow again (was a hardcoded 34, off by 2). */
const HINT_WIDTH = ROW_TEXT_WIDTH - LABEL_WIDTH; // 32

/** Word-boundary wrap so a long description never truncates or overflows. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur.length === 0) cur = w;
    else if ((cur + ' ' + w).length <= width) cur = `${cur} ${w}`;
    else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Truncate a label to fit the fixed label column. */
function truncateLabel(label: string): string {
  const max = LABEL_WIDTH - 2;
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Placeholder hint for the query row, per corpus. */
function placeholder(corpus: Corpus): string {
  if (corpus === 'commands') return 'type to search commands';
  if (corpus === 'output') return 'type to filter output';
  return 'keybindings';
}

/** The palette's props — supplied by the App (which owns input + dispatch). */
export interface PaletteProps {
  readonly corpus: Corpus;
  readonly query: string;
  readonly active: number;
  readonly rows: readonly PaletteRow[];
}

/**
 * Render the palette overlay: an input row + the corpus list. Presentational —
 * the App owns query/active/input and passes the rows in.
 */
export function Palette({ corpus, query, active, rows }: PaletteProps): ReactElement {
  const total = rows.length;
  // Sliding window: the cursor spans the FULL row list; slide a VISIBLE_ROWS
  // window so the active row is always on screen (sticking to the bottom once
  // scrolled). Without this, only the first 10 rows of a ~60-row command list
  // would be reachable.
  const scroll = Math.max(0, Math.min(active - (VISIBLE_ROWS - 1), total - VISIBLE_ROWS));
  const visible = rows.slice(scroll, scroll + VISIBLE_ROWS);
  const activeIndex = Math.min(Math.max(active - scroll, 0), Math.max(0, visible.length - 1));

  const elements: ReactElement[] = [
    <Box key="header" paddingX={1}>
      <Text>
        {c.bold('▸ palette ')}
        <Text>{c.dim(`· ${corpus}`)}</Text>
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
      // A blank spacer before every section (except the first) so the group
      // headers read as distinct, scannable blocks rather than a wall of rows.
      if (lastGroup !== null) {
        elements.push(
          <Box key={`gap:${row.group}`}>
            <Text> </Text>
          </Box>,
        );
      }
      elements.push(
        <Box key={`cat:${row.group}`} paddingX={1}>
          <Text>{c.bold(`── ${row.group} ──`)}</Text>
        </Box>,
      );
      lastGroup = row.group;
    }
    const isActive = i === activeIndex;
    const prefix = isActive ? '▸ ' : '  ';
    const label = truncateLabel(row.primary);
    const labelCol = (prefix + label).padEnd(LABEL_WIDTH);
    // Hint (right column): the argv for command rows, prefixed with `/` so it
    // reads as "the command that runs on Enter" (matching the dashboard's
    // `/command` convention). Non-command rows use the secondary line. Clipped
    // to the hint column so a long keybinding description (help corpus) never
    // overflows the panel.
    const hintRaw = row.argv ? `/${row.argv.join(' ')}` : row.secondary;
    const hint = hintRaw.length > HINT_WIDTH ? `${hintRaw.slice(0, HINT_WIDTH - 1)}…` : hintRaw;

    if (isActive) {
      // Reverse video highlights the whole row — no inner color needed.
      elements.push(
        <Box key={row.key} paddingX={1}>
          <Text>{c.inverse(`${labelCol}${hint}`)}</Text>
        </Box>,
      );
    } else {
      elements.push(
        <Box key={row.key} paddingX={1}>
          <Text>
            {c.bold(labelCol)}
            {hint.length > 0 ? c.dim(hint) : null}
          </Text>
        </Box>,
      );
    }

    // Detail line: the FULL description on the active row, wrapped so it is
    // never truncated. Command rows always show it; help rows show it too
    // (matching command-row UX — the hint column only truncates). Output-corpus
    // rows are excluded: their secondary is a line number / empty-state text,
    // not a description. A leading `↳` marks the detail as belonging to the row
    // above (not a new selectable item); continuation lines align under the
    // text so they read as one wrapped block.
    if (isActive && row.secondary && (row.argv || corpus === 'help')) {
      const detailLines = wrap(row.secondary, ROW_TEXT_WIDTH - 4);
      for (let di = 0; di < detailLines.length; di++) {
        const line = detailLines[di] ?? '';
        const prefix = di === 0 ? '  ↳ ' : '    ';
        elements.push(
          <Box key={`${row.key}:d:${di}`} paddingX={1}>
            <Text>{c.dim(`${prefix}${line}`)}</Text>
          </Box>,
        );
      }
    }
  }

  return (
    <Box flexDirection="column">
      <Panel maxWidth={PALETTE_WIDTH}>{elements}</Panel>
      <Text>{c.dim(LIST_NAV_HINT)}</Text>
    </Box>
  );
}
