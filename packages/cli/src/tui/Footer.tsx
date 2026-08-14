// Footer with the shortcut hints. Kept as a pure function of the running state
// so the App can swap it without re-wiring keybindings. The hint copy lives in
// `hints.ts` (single source of truth) — the bindings themselves live in App.tsx.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../theme.js';
import { FOOTER_HINT, RUNNING_HINT } from './hints.js';

interface FooterProps {
  /** When true, a dispatched command is in flight — show the running hint. */
  running?: boolean;
}

export function Footer({ running }: FooterProps): ReactElement {
  return <Text>{c.dim(running ? RUNNING_HINT : FOOTER_HINT)}</Text>;
}
