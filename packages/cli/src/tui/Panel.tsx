// Shared container — every TUI surface uses this one component for rounded
// borders + width accounting so no caller duplicates `borderStyle round` /
// `borderColor gray` / `width` math.
//
// When `maxWidth` is set the panel caps at that column ceiling — used by the
// command palette for the fixed-width overlay look (like Raycast / VS Code).
// Defaults to full terminal width via contentWidth().

import { Box } from 'ink';
import type { ReactElement, ReactNode } from 'react';
import { contentWidth } from '../theme.js';

export interface PanelProps {
  readonly children: ReactNode;
  /** Optional max-width ceiling in columns (e.g. 64 for the command palette). */
  readonly maxWidth?: number;
}

export function Panel({ children, maxWidth }: PanelProps): ReactElement {
  const full = contentWidth() + 4; // border (2) + inner padding (2)
  const width = maxWidth != null ? Math.min(full, maxWidth) : full;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      {children}
    </Box>
  );
}
