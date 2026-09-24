// Geometry guarantees for tables that cannot fit at their natural width,
// rendered through the REAL cli-table3 (the mocked renderer used elsewhere
// cannot observe an over-wide row). Locks:
//
//   - a table with one very wide column stays inside the terminal at 80, 100
//     and 120 columns (a long header must not pin the column open);
//   - when every column is already at its floor and the content still does
//     not fit, the widest cells are drawn with a visible ellipsis and the row
//     still fits;
//   - the trim loop terminates (a hung loop fails the run, it does not pass);
//   - a degenerate 40-column terminal renders without throwing.
//
// Also locks the width SOURCE: table geometry is measured from stderr (the
// stream tables are written to), falling back to stdout and then to 80.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { table } from '../src/output.js';
import { terminalWidth } from '../src/theme.js';
import { displayWidth } from '../src/width.js';

function captureStderr(): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    read: () => chunks.join(''),
    restore: () => {
      process.stderr.write = orig;
    },
  };
}

function maxLineWidth(out: string): number {
  return Math.max(...out.split('\n').map((line) => displayWidth(line)));
}

function setColumns(stream: NodeJS.WriteStream, value: number | undefined): void {
  Object.defineProperty(stream, 'columns', { value, configurable: true });
}

interface Saved {
  COLUMNS: string | undefined;
  stderrColumns: number | undefined;
  stdoutColumns: number | undefined;
}

let saved: Saved;

beforeEach(() => {
  saved = {
    COLUMNS: process.env.COLUMNS,
    stderrColumns: process.stderr.columns,
    stdoutColumns: process.stdout.columns,
  };
  delete process.env.COLUMNS;
});

afterEach(() => {
  if (saved.COLUMNS === undefined) delete process.env.COLUMNS;
  else process.env.COLUMNS = saved.COLUMNS;
  setColumns(process.stderr, saved.stderrColumns);
  setColumns(process.stdout, saved.stdoutColumns);
});

function renderTable(
  width: number,
  rows: readonly Record<string, unknown>[],
  cols: readonly string[],
): string {
  process.env.COLUMNS = String(width);
  const capture = captureStderr();
  try {
    table(rows, cols, {});
    return capture.read();
  } finally {
    capture.restore();
  }
}

// A single column whose header is far wider than any of the test terminals'
// content budgets, paired with an even wider cell — the shape that used to be
// pinned open by its own header and overflow.
const wideHeader = 'H'.repeat(140);
const wideCell = 'c'.repeat(200);

// Many narrow columns, each carrying a single long token. Their per-column
// padding alone exhausts a small terminal, so after every column reaches its
// floor the cells must be ellipsised for the row to fit.
const manyCols = Array.from({ length: 15 }, (_, i) => `c${i}`);
const manyRow: Record<string, string> = {};
for (const col of manyCols) manyRow[col] = `tok_${col}_${'x'.repeat(40)}`;

describe('table overflow — real cli-table3 rendering', () => {
  it.each([80, 100, 120] as const)(
    'a table with one very wide column never exceeds %i columns',
    (width) => {
      const out = renderTable(width, [{ [wideHeader]: wideCell }], [wideHeader]);
      expect(maxLineWidth(out)).toBeLessThanOrEqual(width);
    },
  );

  it.each([80, 100, 120] as const)(
    'ellipsises rather than overflowing when columns hit their floor at %i columns',
    (width) => {
      const out = renderTable(width, [manyRow], manyCols);
      expect(out).toContain('…');
      expect(maxLineWidth(out)).toBeLessThanOrEqual(width);
    },
  );

  it('the trim loop terminates instead of hanging', () => {
    // This input forces the trim loop down to every column's floor. A correct
    // implementation returns immediately, so an infinite loop fails the run
    // rather than passing silently.
    const out = renderTable(80, [manyRow], manyCols);
    expect(maxLineWidth(out)).toBeLessThanOrEqual(80);
  });

  it('does not throw at a degenerate 40 columns', () => {
    expect(() => renderTable(40, [{ [wideHeader]: wideCell }], [wideHeader])).not.toThrow();
    const out = renderTable(40, [{ [wideHeader]: wideCell }], [wideHeader]);
    expect(maxLineWidth(out)).toBeLessThanOrEqual(40);
  });
});

describe('terminalWidth — measures the stream tables are written to', () => {
  it('prefers stderr.columns over stdout.columns', () => {
    setColumns(process.stderr, 100);
    setColumns(process.stdout, 60);
    expect(terminalWidth()).toBe(100);
  });

  it('falls back to stdout.columns when stderr reports no width', () => {
    setColumns(process.stderr, undefined);
    setColumns(process.stdout, 60);
    expect(terminalWidth()).toBe(60);
  });

  it('defaults to 80 when neither stream reports a width', () => {
    setColumns(process.stderr, undefined);
    setColumns(process.stdout, undefined);
    expect(terminalWidth()).toBe(80);
  });
});
