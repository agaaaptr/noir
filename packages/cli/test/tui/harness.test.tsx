// The TUI render harness, and the gap it exists to close.
//
// `ink-testing-library` injects a stdout shim whose `columns` getter is a
// hard-coded 100, so a test built on it lays the dashboard out for a
// 100-column terminal no matter how wide the terminal actually is. Nothing in
// its API takes a width, which is why an 80-column layout defect could ship
// unseen: no test could ask for 80 columns in the first place.
//
// The first test below documents that gap against the shared harness. The rest
// pin {@link renderAtWidth}, which renders through Ink's own `render` with a
// shim that reports the width the test asks for.

import { Text, useStdout } from 'ink';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { Footer } from '../../src/tui/Footer.js';
import { FOOTER_HINT } from '../../src/tui/hints.js';
import { displayWidth } from '../../src/width.js';
import { renderAtWidth } from '../helpers/render-at-width.js';

/** Renders the column count the terminal reported to Ink. */
function ReportedColumns(): ReactElement {
  const { stdout } = useStdout();
  return <Text>columns={String(stdout.columns)}</Text>;
}

/** The lines a frame actually draws, blank lines dropped. */
function drawnLines(frame: string): string[] {
  return frame.split('\n').filter((line) => line.trim() !== '');
}

/** Pin the width the test process's own stdout reports, and restore it after. */
function withStdoutColumns(columns: number, body: () => void): void {
  const saved = process.stdout.columns;
  Object.defineProperty(process.stdout, 'columns', {
    value: columns,
    configurable: true,
    writable: true,
  });
  try {
    body();
  } finally {
    Object.defineProperty(process.stdout, 'columns', {
      value: saved,
      configurable: true,
      writable: true,
    });
  }
}

describe('the shared harness cannot express a terminal width (the gap)', () => {
  it('reports 100 columns however wide the terminal actually is', () => {
    // The terminal this test runs on says 80. The harness's own shim answers
    // 100 regardless, because its width is a constant, not a measurement.
    withStdoutColumns(80, () => {
      const instance = render(<ReportedColumns />);
      expect(instance.lastFrame() ?? '').toContain('columns=100');
      instance.unmount();
    });
  });
});

describe('renderAtWidth — the terminal width is a parameter', () => {
  it('reports the requested column count to the rendered app', () => {
    const narrow = renderAtWidth(<ReportedColumns />, 80);
    const wide = renderAtWidth(<ReportedColumns />, 200);
    try {
      expect(narrow.frame()).toContain('columns=80');
      expect(wide.frame()).toContain('columns=200');
    } finally {
      narrow.unmount();
      wide.unmount();
    }
  });

  it('lays a line wider than the terminal out for the width it is given', () => {
    // A 105-column line cannot be drawn as one line in 80 columns — a harness
    // leaking the 100-column constant could not produce this wrap, and a wider
    // terminal must produce a shorter frame. The subject is the raw hint text:
    // the Footer itself now cuts its copy to the width it has (asserted in
    // layout-budget.test.tsx), so it no longer wraps on any terminal.
    expect(displayWidth(FOOTER_HINT)).toBeGreaterThan(80);

    const narrow = renderAtWidth(<Text>{FOOTER_HINT}</Text>, 80);
    const wide = renderAtWidth(<Text>{FOOTER_HINT}</Text>, 120);
    try {
      const narrowLines = drawnLines(narrow.frame());
      expect(narrowLines.length).toBeGreaterThan(1);
      for (const line of narrowLines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(80);
      }
      expect(drawnLines(wide.frame()).length).toBeLessThan(narrowLines.length);
      expect(narrow.frame()).not.toBe(wide.frame());
    } finally {
      narrow.unmount();
      wide.unmount();
    }
  });

  it('unmounts without leaving a frame behind', () => {
    const narrow = renderAtWidth(<Footer />, 80);
    const before = narrow.frame();
    expect(before).not.toBe('');

    narrow.unmount();

    // Teardown writes must not become the frame a later assertion reads.
    expect(narrow.frame()).toBe(before);
  });
});
