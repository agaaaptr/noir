// C1 — in-TUI confirmation prompt for a destructive palette dispatch.
//
// Presentational only: it renders the `y/N` prompt for the argv the App wants
// to approve. The App owns the input routing (its single `useInput` handles `y`
// / `n` / Esc in confirm mode) and the dispatch seam, so this component has no
// knowledge of what the command does or how to run it.
//
// Drawn inside a rounded, warn-colored border so a destructive gate is visually
// unmistakable (TUI redesign: rounded outlines on every interactive surface).

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { c, contentWidth } from '../../theme.js';

/** The confirm overlay's props — supplied by the App. */
export interface ConfirmOverlayProps {
  /** The argv being approved, e.g. `['context','index']`. */
  readonly argv: readonly string[];
}

/**
 * Render the `y/N` confirmation prompt. Capital `N` marks the default (decline),
 * matching the CLI's prompt convention.
 */
export function ConfirmOverlay({ argv }: ConfirmOverlayProps): ReactElement {
  return (
    <Box borderStyle="round" borderColor="yellow" paddingX={1} width={contentWidth() + 4}>
      <Text>
        {c.warn(`! run /${argv.join(' ')}? (y/N)`)}
        <Text>{c.dim('  [y approve · n/Esc back to palette]')}</Text>
      </Text>
    </Box>
  );
}
