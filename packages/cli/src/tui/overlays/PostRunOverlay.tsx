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
import { padToWidth, truncateToWidth } from '../../width.js';
import { Panel, panelTextWidth } from '../Panel.js';

const OVERLAY_WIDTH = 64;
/** The `▸ `/`  ` marker that opens every row. */
const ROW_MARKER_WIDTH = 2;
/** The fixed label column, marker included; the hint column takes the rest. */
const LABEL_COLUMN_WIDTH = 26;

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
  // Every cell in a row is measured against the panel's budget, never against a
  // constant: a row that is one column too wide is wrapped by Ink onto a stray
  // flush-left line and the two-column shape collapses. The label column gives
  // way first on a terminal too narrow for it.
  const rowWidth = panelTextWidth(1, OVERLAY_WIDTH);
  const labelColumn = Math.max(0, Math.min(LABEL_COLUMN_WIDTH, rowWidth));
  const hintColumn = Math.max(0, rowWidth - labelColumn);
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
    const marker = focused || !listFocused ? '▸ ' : '  ';
    // Only the focused row shows its hint: the list is short, and one hint at a
    // time keeps the overlay from reading as a wall of text. It is cut to the
    // hint column so the row stays one line.
    const body = focused
      ? padToWidth(
          `${marker}${truncateToWidth(row.label, labelColumn - ROW_MARKER_WIDTH)}`,
          labelColumn,
        ) + truncateToWidth(row.hint, hintColumn)
      : `${marker}${truncateToWidth(row.label, rowWidth - ROW_MARKER_WIDTH)}`;
    elements.push(
      <Box key={row.value} paddingX={1}>
        <Text>{focused ? c.inverse(body) : c.dim(body)}</Text>
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
