// Footer with the shortcut hints. Kept as a pure function of the help/running
// state so the App can swap it without re-wiring keybindings.

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../theme.js';

interface FooterProps {
  /** When true, a dispatched command is in flight — show the running hint. */
  running?: boolean;
}

export function Footer({ running }: FooterProps): ReactElement {
  if (running) {
    return <Text>{c.dim('running… (Ctrl+C to force exit)')}</Text>;
  }
  return (
    <Text>
      {c.dim(
        '? help · q/Esc quit · ↑/↓ scroll · Enter run · Ctrl+K palette · Ctrl+F find · Ctrl+C exit',
      )}
    </Text>
  );
}
