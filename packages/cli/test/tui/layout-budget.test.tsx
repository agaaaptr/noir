// Width budgets, measured against the box that actually draws the text.
//
// Three surfaces used to size their text from constants instead of from the
// container, and each shipped a frame Ink had to wrap: the post-run overlay drew
// a 62-column focused row into a 58-column budget (so the hint's tail landed on
// a stray second line and the two-column list shape collapsed), the dashboard
// divider drew `terminalWidth − 4` dashes into a `terminalWidth − 6` box (so the
// `─` run broke onto a stub line), and the footer rendered a 105-column hint
// untruncated (so it split on any terminal narrower than that).
//
// Every case here renders through a real terminal of a chosen width and asserts
// the frame stays inside the budget it was given — which is the only way to see
// this class of defect: a test on a fixed width cannot ask for the width the bug
// needs.

import type { ReactElement } from 'react';
import stripAnsi from 'strip-ansi';
import { describe, expect, it } from 'vitest';
import type { StatusPayload } from '../../src/commands/status.js';
import type { HostChild, RunHostResult } from '../../src/orchestrator.js';
import { postRunActions } from '../../src/run-actions.js';
import { App } from '../../src/tui/App.js';
import { Footer } from '../../src/tui/Footer.js';
import { FOOTER_HINT } from '../../src/tui/hints.js';
import { type RunDeps, RunMode } from '../../src/tui/modes/run.js';
import { PostRunOverlay } from '../../src/tui/overlays/PostRunOverlay.js';
import { displayWidth, truncateToWidth } from '../../src/width.js';
import { renderAtWidth } from '../helpers/render-at-width.js';

/** The terminal widths the TUI has to lay out for. */
const WIDTHS = [80, 100, 120, 200];

/**
 * The action list a finished run is offered, built by the real builder the run
 * screen and the terminal prompt share — the overlay must fit what is actually
 * on offer, hints included.
 */
const OPTIONS = postRunActions({
  answer: 'the answer text',
  transcript: '/tmp/noir-transcript.jsonl',
  sessionId: 'session-1',
  host: 'claude',
  opts: {},
});

/** A healthy snapshot, so the dashboard draws every region it has. */
const HEALTHY: StatusPayload = {
  noir: '1.15.0',
  project: { id: 'proj-test', name: 'noir-demo' },
  host: 'claude',
  daemon: { running: true, pid: 4242, uptimeSec: 125 },
  store: { docCount: 12, vecCount: 7, dbPath: '/tmp/x.db', degraded: false },
  context: null,
  workflow: {
    taskId: 't-Implement-7',
    phase: 'implement',
    state: 'active',
    mode: 'full',
    nextGate: null,
    degraded: false,
  },
  memory: null,
};

/** The lines a frame draws, blank lines dropped. */
function drawnLines(frame: string): string[] {
  return frame.split('\n').filter((line) => line.trim() !== '');
}

/**
 * Pin the width the process reports for the terminal, and restore it after.
 * Both authorities have to agree on the width: Ink lays the tree out for the
 * harness's shim, and Noir's own helpers read `COLUMNS`. Setting only one leaves
 * the tree laid out for a width the assertion never asked for.
 */
function withColumns(columns: number, body: () => void): void {
  const saved = process.env.COLUMNS;
  process.env.COLUMNS = String(columns);
  try {
    body();
  } finally {
    if (saved === undefined) delete process.env.COLUMNS;
    else process.env.COLUMNS = saved;
  }
}

/** Render `element` at `columns`, hand the drawn lines to `body`, then unmount. */
function withFrame(columns: number, element: ReactElement, body: (lines: string[]) => void): void {
  withColumns(columns, () => {
    const view = renderAtWidth(element, columns);
    try {
      body(drawnLines(view.frame()));
    } finally {
      view.unmount();
    }
  });
}

/** The dashboard, laid out for a terminal of the given width. */
function dashboard(): ReactElement {
  const deps = { dispatch: async (): Promise<void> => {}, fetchStatus: async () => HEALTHY };
  return (
    <App deps={deps} initialPayload={HEALTHY} refreshMs={60000} />
  ) as unknown as ReactElement;
}

/**
 * The run screen over an injected host that never settles: nothing is spawned
 * and the screen stays in its running phase, which is the frame a user sees for
 * the whole of a run.
 */
function runScreen(): ReactElement {
  const child: HostChild = {
    pid: 4242,
    kill: () => true,
    once: () => child,
  };
  const deps: RunDeps = {
    start: (_prompt, handlers) => {
      handlers.onChild?.(child);
      return { binary: 'claude', done: new Promise<RunHostResult>(() => {}) };
    },
    actions: () => [],
    perform: async () => ({ ok: true, message: '' }),
  };
  return (
    <RunMode prompt="fix the bug" deps={deps} onExit={() => {}} tickMs={100000} now={() => 0} />
  ) as unknown as ReactElement;
}

/**
 * True when a panel row draws nothing but the divider: its content, once the
 * `│` borders are dropped, is only `─` characters and spaces. A wrapped dash run
 * leaves exactly such a stub behind, which is what makes this the assertion that
 * counts them.
 */
function isDividerRow(line: string): boolean {
  if (!(line.startsWith('│') && line.endsWith('│'))) return false;
  const inner = line.slice(1, -1).trim();
  return inner.length > 0 && /^─+$/.test(inner);
}

/**
 * What a full-width panel screen has to satisfy: nothing past the terminal, and
 * one divider line filling the row it is drawn in.
 */
function expectInsidePanel(lines: string[], columns: number): void {
  for (const line of lines) {
    expect(displayWidth(line), `line exceeds ${columns} columns: ${line}`).toBeLessThanOrEqual(
      columns,
    );
  }

  const dividers = lines.filter(isDividerRow);
  expect(dividers).toHaveLength(1);

  // The divider fills the row it is drawn in: the panel's width less the round
  // border (2), the panel's own padding (2) and the row's padding (2).
  const panelWidth = displayWidth(lines.find((line) => line.startsWith('╭')) ?? '');
  expect(displayWidth((dividers[0] ?? '').slice(1, -1).trim())).toBe(panelWidth - 6);
}

describe('post-run overlay — the row budget comes from the panel', () => {
  for (const columns of WIDTHS) {
    it(`draws the focused row, hint and all, on one line at ${columns} columns`, () => {
      withColumns(columns, () => {
        const element = (
          <PostRunOverlay options={OPTIONS} active={0} />
        ) as unknown as ReactElement;
        const view = renderAtWidth(element, columns);
        try {
          const lines = drawnLines(view.frame());
          const panelWidth = displayWidth(lines[0] ?? '');
          const panelLines = lines.slice(0, OPTIONS.length + 3); // border + header + rows + border

          // Exactly one line per row: a row wider than its budget wraps, and the
          // wrapped tail becomes a drawer line of its own.
          expect(lines.length).toBe(OPTIONS.length + 4); // panel + the hint under it
          expect(panelWidth).toBeLessThanOrEqual(columns);
          for (const line of panelLines) {
            expect(displayWidth(line), `over-wide row: ${line}`).toBeLessThanOrEqual(panelWidth);
          }

          // The border closes on every row — nothing escaped the frame.
          expect(panelLines[0]?.startsWith('╭')).toBe(true);
          expect(panelLines[panelLines.length - 1]?.startsWith('╰')).toBe(true);
          for (const line of panelLines.slice(1, -1)) {
            expect(line.startsWith('│'), `broken border: ${line}`).toBe(true);
            expect(line.endsWith('│'), `broken border: ${line}`).toBe(true);
          }

          // The focused row carries its hint in a second column: a column of
          // space after the label, then the hint on the SAME line.
          const label = OPTIONS[0]?.label ?? '';
          const hintHead = (OPTIONS[0]?.hint ?? '').slice(0, 24);
          const focusedRow = panelLines.find((line) => line.includes(`▸ ${label}`));
          expect(focusedRow, `no focused row for ${label}`).toBeDefined();
          expect(focusedRow ?? '').toContain(hintHead);
          expect((focusedRow ?? '').indexOf(hintHead)).toBeGreaterThan(
            (focusedRow ?? '').indexOf(label) + label.length,
          );
        } finally {
          view.unmount();
        }
      });
    });
  }

  it('boxes an over-long label on the non-focused rows instead of wrapping it', () => {
    // Every label on offer today is short, so the non-focused path only
    // overflows on a label nobody has written yet — the row is still the same
    // box and the same budget.
    const long: readonly (typeof OPTIONS)[number][] = OPTIONS.map((option) => ({
      ...option,
      label: `${option.label} — ${'word '.repeat(30)}`,
    }));
    withColumns(80, () => {
      const element = (<PostRunOverlay options={long} active={0} />) as unknown as ReactElement;
      const view = renderAtWidth(element, 80);
      try {
        const lines = drawnLines(view.frame());
        const panelWidth = displayWidth(lines[0] ?? '');
        expect(lines.length).toBe(OPTIONS.length + 4);
        for (const line of lines.slice(0, OPTIONS.length + 3)) {
          expect(displayWidth(line), `over-wide row: ${line}`).toBeLessThanOrEqual(panelWidth);
        }
      } finally {
        view.unmount();
      }
    });
  });
});

describe('dashboard and run screen — the divider is sized to the box it is drawn in', () => {
  for (const columns of [80, 120, 200]) {
    it(`keeps every dashboard line inside ${columns} columns and draws the divider once`, () => {
      withFrame(columns, dashboard(), (lines) => expectInsidePanel(lines, columns));
    });

    it(`keeps every run-screen line inside ${columns} columns and draws the divider once`, () => {
      withFrame(columns, runScreen(), (lines) => expectInsidePanel(lines, columns));
    });
  }
});

describe('footer — the hint is cut to the terminal instead of wrapping', () => {
  it('renders the 80-column hint on a single line, quit keys included', () => {
    // The hint is wider than the terminal it is drawn on, so it has to be cut —
    // untruncated, it wraps and its tail lands on a flush-left second line.
    expect(displayWidth(FOOTER_HINT)).toBeGreaterThan(80);

    withFrame(80, (<Footer />) as unknown as ReactElement, (lines) => {
      expect(lines).toHaveLength(1);
      // As much of the hint as fits, marked as cut, and nothing wider.
      expect(stripAnsi(lines[0] ?? '')).toBe(truncateToWidth(FOOTER_HINT, 80));
      expect(displayWidth(lines[0] ?? '')).toBeLessThanOrEqual(80);
      // What the cut must never take: the only quit instructions the dashboard
      // shows, which is why they lead the hint.
      expect(lines[0] ?? '').toContain('q/Esc quit');
      expect(lines[0] ?? '').toContain('Ctrl+C exit');
    });
  });
});
