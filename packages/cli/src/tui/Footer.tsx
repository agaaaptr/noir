// Footer with the shortcut hints. Kept as a pure function of the running state
// so the App can swap it without re-wiring keybindings. The hint copy lives in
// `hints.ts` (single source of truth) — the bindings themselves live in App.tsx.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c, terminalWidth } from '../theme.js';
import { truncateToWidth } from '../width.js';
import { FOOTER_HINT, RUNNING_HINT } from './hints.js';

interface FooterProps {
  /** When true, a dispatched command is in flight — show the running hint. */
  running?: boolean;
}

export function Footer({ running }: FooterProps): ReactElement {
  // The hint is wider than a narrow terminal, so it is cut to the width the
  // footer actually has (the full terminal — it draws outside any panel).
  // Untruncated, Ink wraps it and the tail lands on a flush-left second line.
  // The cut is measured in display columns and returns plain text, so the colour
  // is applied to the result rather than to what was measured.
  const hint = truncateToWidth(running ? RUNNING_HINT : FOOTER_HINT, terminalWidth());
  return <Text>{c.dim(hint)}</Text>;
}
