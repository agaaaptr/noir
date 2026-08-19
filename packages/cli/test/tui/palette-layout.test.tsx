// Regression for the v1.11.2 palette two-column wrap bug: the help corpus
// budgeted label(26) + hint(34) = 60 columns, but the actual text width inside
// the row is 58 (PALETTE_WIDTH 64 − round border 2 − Panel paddingX 2 − row
// paddingX 2), so long keybinding descriptions wrapped to a flush-left second
// line. Renders the real Palette + HELP_ENTRIES and asserts the layout stays
// single-line and that the active help row shows the full description detail.
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import { Palette } from '../../src/tui/palette/Palette.js';
import { type BuildRowsInput, buildPaletteRows, VISIBLE_ROWS } from '../../src/tui/palette/rows.js';

function renderHelp(): ReturnType<typeof render> {
  const input: BuildRowsInput = {
    corpus: 'help',
    query: '',
    commands: [],
    matcher: handRolledMatcher,
    recent: [],
    homeSections: [],
    outputLines: [],
  };
  const rows = buildPaletteRows(input);
  const el = (<Palette corpus="help" query="" active={0} rows={rows} />) as unknown as ReactElement;
  return render(el);
}

describe('palette layout — help corpus (regression: two-column wrap)', () => {
  it('renders every visible help row on a single line (no wrapped continuation lines)', () => {
    const instance = renderHelp();
    const frame = instance.lastFrame() ?? '';
    const lines = frame.split('\n');
    // No-wrap layout accounting (active row 0 = /command):
    //   1 top border + 1 header + 1 query + 1 group header + VISIBLE_ROWS rows
    //   + 2 detail lines (active help row, full /command description wraps to 2)
    //   + 1 bottom border + 1 list hint = 18 lines.
    // The shipped bug wrapped 8 of the visible hints → 24 lines.
    expect(lines.length).toBe(1 + 1 + 1 + 1 + VISIBLE_ROWS + 2 + 1 + 1);
    instance.unmount();
  });

  it('every rendered line stays within the panel width (64 cols)', () => {
    const instance = renderHelp();
    const frame = instance.lastFrame() ?? '';
    // The panel is 64 cols total (border 2 + padding 2 + text 58); no line may
    // exceed that width — an over-wide row is what wraps (the v1.11.2 bug).
    // Strip SGR color codes (ink emits them when color is on) before measuring.
    // The regex is assembled at runtime from String.fromCharCode(27) so the
    // source carries no control character (which biome forbids in regex literals).
    // biome-ignore lint/style/useTemplate: the ANSI pattern is built at runtime to avoid a literal control char
    const ansi = String.fromCharCode(27) + '\\[[0-9;]*m';
    const stripAnsi = new RegExp(ansi, 'g');
    const max = 64;
    for (const raw of frame.split('\n')) {
      const line = raw.replace(stripAnsi, '');
      expect(line.length, `line exceeds ${max} cols: ${line}`).toBeLessThanOrEqual(max);
    }
    instance.unmount();
  });

  it('shows the FULL keybinding description as a detail line on the active help row', () => {
    const instance = renderHelp();
    const frame = instance.lastFrame() ?? '';
    // The detail line is word-wrapped to the row budget, so assert on its first
    // segment + the `↳` marker (a wrapped description would be truncated with
    // '…' instead and never appear as detail).
    expect(frame).toContain('↳ run a Noir sub-command (e.g.');
    instance.unmount();
  });
});
