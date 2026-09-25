// Width single-sourcing regressions for the TUI surfaces that lay text out in
// columns. Both assert on VISIBLE width (terminal columns), not UTF-16 code
// units: a wide CJK glyph or an emoji occupies two columns, so a `.length` /
// `.slice` measurement pads or cuts at the wrong column and shifts the next
// element (or overflows the panel).
//
// Offline and free: renders components in memory, no network, no key.
//
// A wide CJK glyph is a fixture here on purpose: it is the case a code-unit
// measurement gets wrong, so this file states its own exemption from the
// irregular-script rule rather than the rule carrying a CJK allowance.
// noir-hygiene: exempt

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { OutputPane } from '../../src/tui/OutputPane.js';
import { Palette } from '../../src/tui/palette/Palette.js';
import type { PaletteRow } from '../../src/tui/palette/rows.js';
import { displayWidth } from '../../src/width.js';

/** Strip the SGR colour codes ink emits so a frame's columns are measurable.
 *  Assembled at runtime so the source carries no literal control character. */
function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

describe('width single-sourcing — palette label column', () => {
  it('pads a wide-char label to the label column so the hint does not shift', () => {
    const row: PaletteRow = {
      key: 'wide',
      primary: '汉', // display width 2, UTF-16 length 1 — the mis-pad case
      secondary: 'hint',
      argv: null,
      destructive: false,
      group: null,
    };
    const el = (
      <Palette corpus="commands" query="" active={0} rows={[row]} />
    ) as unknown as ReactElement;
    const instance = render(el);
    const frame = instance.lastFrame() ?? '';
    instance.unmount();

    // The row line is the one carrying the hint. Strip ANSI, then the round
    // border (│) and the panel + row padding, leaving the row text: the label
    // column (prefix + label + pad) followed by the hint.
    const rowLine = frame
      .split('\n')
      .map(stripAnsi)
      .find((l) => l.includes('hint'));
    expect(rowLine).toBeDefined();
    const inner = (rowLine ?? '').trim().slice(1, -1).trim();
    const hintAt = inner.indexOf('hint');
    // The label column must occupy exactly 26 visible columns, so `hint` starts
    // at column 26. The old `.padEnd` measured UTF-16 units: the wide label (1
    // unit, 2 columns) left the column one short and pushed the hint right.
    expect(displayWidth(inner.slice(0, hintAt))).toBe(26);
  });
});

describe('width single-sourcing — output pane row cut', () => {
  it('cuts a wide-char line at the visible width, not the code-unit count', () => {
    const prev = process.env.COLUMNS;
    process.env.COLUMNS = '34'; // contentWidth() = terminalWidth(34) − border(2) − padding(2) = 30
    try {
      const line = `${'a'.repeat(20)}汉${'b'.repeat(20)}`; // 20 + 2 + 20 = 42 columns
      const instance = render(<OutputPane lines={[line]} scrollOffset={0} />);
      const frame = (instance.lastFrame() ?? '').trimEnd();
      instance.unmount();

      // 20 + wide(2) + 7 + '…'(1) = 30: the wide char is charged two columns, so
      // the cut lands after 7 b's. A `.slice` cut would keep the line one column
      // over budget (the wide char counted as one code unit).
      expect(frame.endsWith('…')).toBe(true);
      expect(displayWidth(frame)).toBe(30);
    } finally {
      process.env.COLUMNS = prev;
    }
  });
});
