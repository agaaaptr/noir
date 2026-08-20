// Shared container — every TUI surface uses this one component for rounded
// borders + width accounting so no caller duplicates `borderStyle round` /
// `borderColor gray` / `width` math.
//
// When `maxWidth` is set the panel caps at that column ceiling — used by the
// command palette for the fixed-width overlay look (like Raycast / VS Code).
// Defaults to full terminal width via contentWidth().

import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { contentWidth, useColor } from '../theme.js';

export interface PanelProps {
  readonly children: ReactNode;
  /** Optional max-width ceiling in columns (e.g. 64 for the command palette). */
  readonly maxWidth?: number;
}

export function Panel({ children, maxWidth }: PanelProps): ReactElement {
  const full = contentWidth() + 4; // border (2) + inner padding (2)
  const width = maxWidth != null ? Math.min(full, maxWidth) : full;
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
