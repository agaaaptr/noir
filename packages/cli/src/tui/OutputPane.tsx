// Scrollable output pane. Renders a windowed slice of `lines` based on the
// current scroll offset (controlled by ArrowUp/ArrowDown at the App level).
// Two sources of text share this pane: (a) the live project snapshot (the same
// payload `noir status` shows), and (b) the captured stdout/stderr of a
// dispatched `/<command>`. When dispatched output is present it takes
// precedence (the user just asked for it); the App returns to the snapshot view
// when the output is dismissed.
//
// Search (C2): when `highlightQuery` is set, the matched substring within each
// visible line is drawn bold (`c.bold`); the line whose index equals
// `activeLine` is drawn in the brand accent (`c.accent`). The App supplies
// these in search mode — a no-op combination (highlight off + no active line)
// renders exactly the pre-search plain text.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c, contentWidth } from '../theme.js';

interface OutputPaneProps {
  lines: readonly string[];
  /** Index of the FIRST line scrolled to the top of the viewport. */
  scrollOffset: number;
  /** Visible row height of the pane. Defaults to a comfortable 12 rows. */
  height?: number;
  /** Optional title for the pane (shown as a dim header line). */
  title?: string;
  /**
   * When set, the matched substring of every visible line is drawn bold. Only
   * supplied by the App in search mode.
   */
  highlightQuery?: string;
  /**
   * When set to a line index, that line is drawn in the brand accent. Only
   * supplied by the App in search mode (the active match's line).
   */
  activeLine?: number;
}

interface Row {
  /** Stable, content-derived React key (deduplicated so duplicate lines don't collide). */
  key: string;
  /** The text to render for this row. */
  text: string;
  /** Absolute index into the pane's `lines` (for the active-line accent). */
  index: number;
}

/**
 * Build stable React keys from line content. Duplicate lines get a `#N` suffix
 * so each row's key is unique WITHOUT using the array index — the lint rule
 * flags index keys, and content keys are also correct here (the pane is read-
 * only, but content keys keep reconciliation honest across scroll refreshes).
 */
function toRows(visible: readonly string[], baseIndex: number): Row[] {
  const rows: Row[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < visible.length; i++) {
    const text = visible[i] ?? '';
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    rows.push({
      key: n === 1 ? text || '_blank' : `${text || '_blank'}#${n}`,
      text,
      index: baseIndex + i,
    });
  }
  return rows;
}

/**
 * Render `text` with the FIRST (case-insensitive) occurrence of `query` drawn
 * bold. Returns `text` untouched when the query is empty or not found.
 */
function highlightFirst(text: string, query: string): string {
  if (query.length === 0) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return `${text.slice(0, idx)}${c.bold(text.slice(idx, idx + query.length))}${text.slice(
    idx + query.length,
  )}`;
}

export function OutputPane({
  lines,
  scrollOffset,
  height = 12,
  title,
  highlightQuery,
  activeLine,
}: OutputPaneProps): ReactElement {
  // Content width already accounts for the parent panel's border + padding
  // (see contentWidth()). Truncating to this (not the full terminal width)
  // keeps long lines — like the `noir status` table — inside the rounded box.
  const width = contentWidth();

  if (lines.length === 0) {
    return <Text>{c.dim('(no output — type a /command, or ? for help)')}</Text>;
  }

  // Clamp the offset into range so a stale value (e.g. after the content
  // shrinks) never produces a blank pane.
  const maxOffset = Math.max(0, lines.length - height);
  const offset = Math.min(Math.max(0, scrollOffset), maxOffset);
  const rows = toRows(lines.slice(offset, offset + height), offset);

  return (
    <>
      {title !== undefined ? <Text wrap="truncate-end">{c.dim(`── ${title} ──`)}</Text> : null}
      {rows.map((row) => {
        const truncated =
          row.text.length > width ? `${row.text.slice(0, Math.max(1, width - 1))}…` : row.text;
        // The active search-match line is drawn in the accent; other lines are
        // plain (with the matched substring bold when a query is live).
        let body: string = truncated;
        if (activeLine !== undefined && row.index === activeLine) {
          body = c.accent(truncated);
        } else if (highlightQuery !== undefined && highlightQuery.length > 0) {
          body = highlightFirst(truncated, highlightQuery);
        }
        // wrap="truncate-end" guarantees a long line never wraps inside the
        // bordered panel — the manual truncate above is the first line of
        // defense; this is the second (Ink will hard-truncate if the panel is
        // narrower than contentWidth() reported, e.g. under a tiny COLUMNS).
        return (
          <Text key={row.key} wrap="truncate-end">
            {body}
          </Text>
        );
      })}
    </>
  );
}
