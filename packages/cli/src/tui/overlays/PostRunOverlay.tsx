// The post-run overlay: what to do with the answer that just streamed past.
//
// Presentational. The run screen owns the input routing (arrow keys, Enter,
// Esc, and the value line) and the performer seam; this component paints the
// rows and the state they are in. The rows themselves come from the shared
// action set the terminal prompt also renders — the overlay decides how a row
// LOOKS, never what it does, so the two surfaces cannot offer different things.
//
// The row idiom is the palette's: a `▸ ` marker and reverse video on the
// focused row, the whole list dimmed while the value step owns the keyboard
// (otherwise the highlight would read as "Enter still picks this row" when
// Enter now submits the text), and a hint line under the panel.

import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import type { PostRunMenuOption } from '../../run-actions.js';
import { c } from '../../theme.js';
import { Panel } from '../Panel.js';

const OVERLAY_WIDTH = 64;

/** The value step: the question, what has been typed, and any one-line notice. */
export interface PostRunValueStep {
  readonly label: string;
  readonly placeholder: string;
  readonly value: string;
  readonly notice?: string;
}

export interface PostRunOverlayProps {
  readonly options: readonly PostRunMenuOption[];
  /** Index of the focused row (ignored while a value step or a job is open). */
  readonly active: number;
  /** Set while a value is being collected for the focused row. */
  readonly value?: PostRunValueStep;
  /** Set while the chosen action is running. */
  readonly working?: boolean;
  /** What the action just did, once it is finished. */
  readonly result?: { readonly ok: boolean; readonly message: string };
}

/** Truncate a label so a long one cannot wrap the two-column row. */
function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

export function PostRunOverlay({
  options,
  active,
  value,
  working = false,
  result,
}: PostRunOverlayProps): ReactElement {
  // A value step and a running action both take the keyboard away from the
  // list, so neither may leave a row looking selected.
  const listFocused = value === undefined && !working && result === undefined;
  const elements: ReactElement[] = [
    <Box key="header" paddingX={1}>
      <Text>
        {c.bold('▸ run finished ')}
        <Text>{c.dim('· what next?')}</Text>
      </Text>
    </Box>,
  ];

  for (let i = 0; i < options.length; i++) {
    const row = options[i];
    if (!row) continue;
    const focused = listFocused && i === active;
    // Only the focused row shows its hint: the list is short, and one hint at a
    // time keeps the overlay from reading as a wall of text.
    const body = focused
      ? `${truncate(row.label, 28).padEnd(30)}${truncate(row.hint, 30)}`
      : truncate(row.label, 60);
    elements.push(
      <Box key={row.value} paddingX={1}>
        <Text>
          {focused ? c.inverse(`▸ ${body}`) : c.dim(listFocused ? `  ${body}` : `▸ ${body}`)}
        </Text>
      </Box>,
    );
  }

  if (value !== undefined) {
    elements.push(
      <Box key="value" paddingX={1}>
        <Text>
          {c.accent('▸ ')}
          {value.value.length > 0 ? value.value : c.dim(value.placeholder)}
          <Text>{c.dim('▌')}</Text>
        </Text>
      </Box>,
      <Box key="value-label" paddingX={1}>
        <Text>{c.dim(`${value.label} — Enter to continue · Esc to go back`)}</Text>
      </Box>,
    );
  }
  if (value?.notice !== undefined) {
    elements.push(
      <Box key="value-notice" paddingX={1}>
        <Text>{c.warn(value.notice)}</Text>
      </Box>,
    );
  }
  if (working) {
    elements.push(
      <Box key="working" paddingX={1}>
        <Text>{c.dim('working…')}</Text>
      </Box>,
    );
  }
  if (result !== undefined) {
    elements.push(
      <Box key="result" paddingX={1}>
        <Text>{result.ok ? c.ok(result.message) : c.warn(result.message)}</Text>
      </Box>,
    );
    elements.push(
      <Box key="result-hint" paddingX={1}>
        <Text>{c.dim('Enter or Esc to close')}</Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column">
      <Panel maxWidth={OVERLAY_WIDTH}>{elements}</Panel>
      <Text>
        {c.dim(
          result !== undefined
            ? 'Enter close'
            : value !== undefined
              ? 'type the value · Enter continue · Esc back'
              : '↑/↓ choose · Enter run · Esc dismiss',
        )}
      </Text>
    </Box>
  );
}
