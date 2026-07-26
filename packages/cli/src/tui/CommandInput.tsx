// Command input display. The input buffer + cursor live in the App (so is the
// keybinding dispatch); this component is purely presentational — it renders
// the prefix convention (`/` invokes a native Noir subcommand, bare text is a
// hint) and shows a block cursor at the end of the buffer.
//
// The hint rule: when the buffer is empty, show a dim placeholder describing
// the convention; once the user types, render the buffer verbatim with an
// accent prefix when the first char is `/` (a recognized dispatch) or a dim
// prefix otherwise (a hint that this input would NOT dispatch on Enter).

import { Text } from 'ink';
import type { ReactElement } from 'react';
import { c } from '../theme.js';

interface CommandInputProps {
  buffer: string;
  running?: boolean;
}

export function CommandInput({ buffer, running }: CommandInputProps): ReactElement {
  if (running) {
    return <Text>{c.dim('…')}</Text>;
  }
  if (buffer.length === 0) {
    return <Text>{c.dim('type a /command (e.g. /status, /sync, /task next), or q to quit')}</Text>;
  }
  const isCommand = buffer.startsWith('/');
  return (
    <Text>
      <Text>{isCommand ? c.accent('▸') : c.dim('▸')}</Text> {buffer}
      <Text>{c.dim('▌')}</Text>
    </Text>
  );
}
