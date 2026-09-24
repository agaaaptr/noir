// Shared container — every TUI surface uses this one component for rounded
// borders + width accounting so no caller duplicates `borderStyle round` /
// `borderColor gray` / `width` math.
//
// When `maxWidth` is set the panel caps at that column ceiling — used by the
// command palette for the fixed-width overlay look (like Raycast / VS Code).
// Defaults to full terminal width via contentWidth().
//
// The panel OWNS the width budget of everything drawn inside it, so it also
// publishes that budget ({@link panelTextWidth}): a row that sizes its text from
// a constant instead of from this number is a row Ink has to wrap.

import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { contentWidth, useColor } from '../theme.js';

/** Columns the panel itself spends: a 1-column border on each side (2) plus `paddingX={1}` (2). */
const PANEL_CHROME = 4;

/**
 * The width a panel takes: its full-terminal width, capped at `maxWidth` when
 * a ceiling is given. A narrow terminal wins over the ceiling, so a fixed-width
 * overlay shrinks with the window instead of overflowing it.
 */
function panelWidth(maxWidth?: number): number {
  const full = contentWidth() + PANEL_CHROME;
  return maxWidth != null ? Math.min(full, maxWidth) : full;
}

/**
 * The columns a panel hands to a child's text, once the panel's own border and
 * padding are paid for. `padding` is the horizontal padding the CHILD adds for
 * itself — each 1-column inset costs 2 columns.
 *
 * Sizing text from this number is what keeps a row inside its box: a row one
 * column too wide is wrapped by Ink onto a stray second line, which reads as the
 * list losing its shape rather than as a row that did not fit.
 */
export function panelTextWidth(padding = 0, maxWidth?: number): number {
  return Math.max(0, panelWidth(maxWidth) - PANEL_CHROME - padding * 2);
}

export interface PanelProps {
  readonly children: ReactNode;
  /** Optional max-width ceiling in columns (e.g. 64 for the command palette). */
  readonly maxWidth?: number;
}

export function Panel({ children, maxWidth }: PanelProps): ReactElement {
  const width = panelWidth(maxWidth);
  // The border color rides the SAME color authority as every other surface:
  // when colors are off (NO_COLOR / non-TTY), pass `undefined` so Ink renders
  // the border in the default terminal color with no ANSI — a hardcoded
  // borderColor="gray" bypassed useColor() and left colored borders around
  // plain content (the documented NO_COLOR contract).
  const borderColor = useColor() ? ('gray' as const) : undefined;
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      paddingX={1}
      width={width}
    >
      {children}
    </Box>
  );
}
