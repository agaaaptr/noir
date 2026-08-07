// Command input display. The input buffer + cursor live in the App (so is the
// keybinding dispatch); this component is purely presentational — it renders
// the prefix convention (`/` invokes a native Noir subcommand, bare text is a
// hint) and shows a block cursor at the end of the buffer.
//
// The hint rule: when the buffer is empty, show a dim placeholder describing
// the convention; once the user types, render the buffer verbatim with an
// accent prefix when the first char is `/` (a recognized dispatch) or a dim
// prefix otherwise (a hint that this input would NOT dispatch on Enter).
//
// The input is drawn inside a rounded border so the interactive field is
// visually distinct from the static output above it (TUI redesign: rounded
// outlines on every interactive surface).

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { c, contentWidth } from '../theme.js';

interface CommandInputProps {
  buffer: string;
  running?: boolean;
}

export function CommandInput({ buffer, running }: CommandInputProps): ReactElement {
  if (running) {
    return (
      <Box borderStyle="round" borderColor="gray" paddingX={1} width={contentWidth() + 4}>
        <Text>{c.dim('…')}</Text>
      </Box>
    );
  }
  let body: ReactElement;
  if (buffer.length === 0) {
    body = (
      <Text>
        <Text>{c.dim('▌')}</Text>{' '}
        <Text>{c.dim('type a /command (e.g. /status, /sync, /task next), or q to quit')}</Text>
      </Text>
    );
  } else {
    const isCommand = buffer.startsWith('/');
    body = (
      <Text>
        <Text>{isCommand ? c.accent('▸') : c.dim('▸')}</Text> {buffer}
        <Text>{c.dim('▌')}</Text>
      </Text>
    );
  }
  return (
    <Box borderStyle="round" borderColor="gray" paddingX={1} width={contentWidth() + 4}>
      {body}
    </Box>
  );
}
