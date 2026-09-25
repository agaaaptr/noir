// Scrollable output pane. Renders a windowed slice of `lines` based on the
// current scroll offset (controlled by ArrowUp/ArrowDown at the App level).
// Two sources of text share this pane: (a) the live project snapshot (the same
// payload `noir status` shows), and (b) the captured stdout/stderr of a
// dispatched `/<command>`. When dispatched output is present it takes
// precedence (the user just asked for it); the App returns to the snapshot view
// when the output is dismissed.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c, contentWidth } from '../theme.js';
import { displayWidth, truncateToWidth } from '../width.js';

interface OutputPaneProps {
  lines: readonly string[];
  /** Index of the FIRST line scrolled to the top of the viewport. */
  scrollOffset: number;
  /** Visible row height of the pane. Defaults to a comfortable 12 rows. */
  height?: number;
  /** Optional title for the pane (shown as a dim header line). */
  title?: string;
  /**
   * Show the NEWEST lines rather than the oldest — for output still arriving,
   * where the interesting end is the one still being written. `scrollOffset` is
   * ignored while this is set.
   */
  followTail?: boolean;
}

interface Row {
  /** Stable, content-derived React key (deduplicated so duplicate lines don't collide). */
  key: string;
  /** The text to render for this row. */
  text: string;
}

/**
 * Build stable React keys from line content. Duplicate lines get a `#N` suffix
 * so each row's key is unique WITHOUT using the array index — the lint rule
 * flags index keys, and content keys are also correct here (the pane is read-
 * only, but content keys keep reconciliation honest across scroll refreshes).
 */
function toRows(visible: readonly string[]): Row[] {
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < visible.length; i++) {
    const text = visible[i] ?? '';
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    rows.push({ key: n === 1 ? text || '_blank' : `${text || '_blank'}#${n}`, text });
  }
  return rows;
}

export function OutputPane({
  lines,
  scrollOffset,
  height = 12,
  title,
  followTail = false,
}: OutputPaneProps): ReactElement {
  // Content width already accounts for the parent panel's border + padding
  // (see contentWidth()). Truncating to this (not the full terminal width)
  // keeps long lines — like the `noir status` table — inside the rounded box.
  const width = contentWidth();

  if (lines.length === 0) {
    return <Text>{c.dim('(no output — type a /command, or ? for help)')}</Text>;
  }

  // Clamp the offset into range so a stale value (e.g. after the content
  // shrinks) never produces a blank pane. A live pane pins to the bottom
  // instead: the newest line is the one being written, and it is what the user
  // is watching for.
  const maxOffset = Math.max(0, lines.length - height);
  const offset = followTail ? maxOffset : Math.min(Math.max(0, scrollOffset), maxOffset);
  const rows = toRows(lines.slice(offset, offset + height));

  return (
    <>
      {title !== undefined ? <Text wrap="truncate-end">{c.dim(`── ${title} ──`)}</Text> : null}
      {rows.map((row) => {
        // Cut a too-wide line at the VISIBLE width, not the code-unit count:
        // a wide CJK glyph or emoji occupies two columns, so a `.slice` would
        // leave the row over budget. Lines that already fit pass through
        // untouched (their ANSI colour is kept); a cut line is measured after
        // stripping ANSI so the marker lands at the right column.
        const truncated =
          displayWidth(row.text) > width ? truncateToWidth(row.text, width) : row.text;
        // wrap="truncate-end" guarantees a long line never wraps inside the
        // bordered panel — the manual truncate above is the first line of
        // defense; this is the second (Ink will hard-truncate if the panel is
        // narrower than contentWidth() reported, e.g. under a tiny COLUMNS).
        return (
          <Text key={row.key} wrap="truncate-end">
            {truncated}
          </Text>
        );
      })}
    </>
  );
}
