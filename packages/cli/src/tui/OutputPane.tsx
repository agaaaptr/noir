// Scrollable output pane. Renders a windowed slice of `lines` based on the
// current scroll offset (controlled by ArrowUp/ArrowDown at the App level).
// Two sources of text share this pane: (a) the live project snapshot (the same
// payload `noir status` shows), and (b) the captured stdout/stderr of a
// dispatched `/<command>`. When dispatched output is present it takes
// precedence (the user just asked for it); the App returns to the snapshot view
// when the output is dismissed.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c, terminalWidth } from '../theme.js';

interface OutputPaneProps {
  lines: readonly string[];
  /** Index of the FIRST line scrolled to the top of the viewport. */
  scrollOffset: number;
  /** Visible row height of the pane. Defaults to a comfortable 12 rows. */
  height?: number;
  /** Optional title for the pane (shown as a dim header line). */
  title?: string;
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
  for (const text of visible) {
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
}: OutputPaneProps): ReactElement {
  const width = terminalWidth();

  if (lines.length === 0) {
    return <Text>{c.dim('(no output — type a /command, or ? for help)')}</Text>;
  }

  // Clamp the offset into range so a stale value (e.g. after the content
  // shrinks) never produces a blank pane.
  const maxOffset = Math.max(0, lines.length - height);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const rows = toRows(lines.slice(offset, offset + height));

  return (
    <>
      {title !== undefined ? <Text>{c.dim(`── ${title} ──`)}</Text> : null}
      {rows.map((row) => (
        <Text key={row.key}>
          {row.text.length > width ? `${row.text.slice(0, Math.max(1, width - 1))}…` : row.text}
        </Text>
      ))}
    </>
  );
}
