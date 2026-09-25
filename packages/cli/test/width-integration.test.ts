// Integration tests for the CLI's layout sites, proving the observable
// defects of `String.length`-based measurement are gone:
//
//   - a coloured badge allocates its VISIBLE width, not its escape-inflated
//     code-unit length;
//   - a wide (East-Asian) character is allocated two columns, not one;
//   - a doctor-shaped row lays out the same Status column with colour on and
//     off (measurement must not depend on whether decoration is emitted);
//   - a path-valued cell is cut in the middle so both the leading directories
//     and the final file name survive.
//
// cli-table3 is mocked so the column widths and the cell text `table()` hands
// to it can be inspected directly — the real renderer's own index-based
// truncation would otherwise hide whether OUR measurement was right.
//
// A wide CJK glyph is a fixture here on purpose: it is the case a code-unit
// measurement gets wrong, so this file states its own exemption from the
// irregular-script rule rather than the rule carrying a CJK allowance.
// noir-hygiene: exempt
import stripAnsi from 'strip-ansi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => {
  const tables: { opts: Record<string, unknown>; rows: string[][] }[] = [];
  return { tables };
});

vi.mock('cli-table3', () => ({
  default: class MockTable {
    readonly opts: Record<string, unknown>;
    readonly rows: string[][] = [];
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      captured.tables.push({ opts, rows: this.rows });
    }
    push(...rows: string[][]): void {
      for (const row of rows) this.rows.push(row);
    }
    toString(): string {
      return '';
    }
  },
}));

import { table } from '../src/output.js';
import { badge } from '../src/theme.js';
import { displayWidth, truncateToWidth } from '../src/width.js';

function lastTable(): { opts: Record<string, unknown>; rows: string[][] } {
  const t = captured.tables[captured.tables.length - 1];
  if (!t) throw new Error('no table rendered');
  return t;
}

function colWidths(): number[] {
  return lastTable().opts.colWidths as number[];
}

function cells(): string[] {
  return lastTable().rows[0] ?? [];
}

// --- env + stderr management ------------------------------------------------
const saved: Record<string, string | undefined> = {};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved.NO_COLOR = process.env.NO_COLOR;
  saved.CLICOLOR_FORCE = process.env.CLICOLOR_FORCE;
  saved.CI = process.env.CI;
  saved.COLUMNS = process.env.COLUMNS;
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
  delete process.env.CI;
  setEnv('COLUMNS', '80');
  captured.tables.length = 0;
  // `table()` writes the rendered string to stderr; the mock returns '' so only
  // the trailing newline would land there. Silence it to keep the run clean.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  setEnv('NO_COLOR', saved.NO_COLOR);
  setEnv('CLICOLOR_FORCE', saved.CLICOLOR_FORCE);
  setEnv('CI', saved.CI);
  setEnv('COLUMNS', saved.COLUMNS);
  vi.restoreAllMocks();
});

describe('table column widths — display width, not code units', () => {
  it('allocates a coloured badge its visible width, not its escape-inflated length', () => {
    process.env.CLICOLOR_FORCE = '1';
    const cell = badge('warn', 'WARN');
    expect(cell.length).toBeGreaterThan(displayWidth(cell)); // the defect's raw material

    table([{ Status: cell }], ['Status'], {});

    expect(colWidths()).toEqual([displayWidth(cell) + 2]);
    expect(displayWidth(cell)).toBe(6);
  });

  it('allocates a wide character two columns', () => {
    const cell = '中文中';
    expect(cell.length).toBe(3); // three code units…

    table([{ Value: cell }], ['Value'], {});

    expect(displayWidth(cell)).toBe(6); // …but six terminal columns
    expect(colWidths()).toEqual([displayWidth(cell) + 2]);
  });

  it('gives a doctor-shaped row the same Status column width with colour on and off', () => {
    const rows = () => [
      { Check: 'runtime', Status: badge('ok', 'OK'), Detail: 'node 22 · healthy' },
      {
        Check: 'native deps',
        Status: badge('warn', 'WARN'),
        Detail: 'better-sqlite3 loadable but sqlite-vec missing — search degrades to BM25',
      },
      { Check: 'store', Status: badge('error', 'FAIL'), Detail: 'store DB would not open' },
    ];
    setEnv('COLUMNS', '200'); // no trimming: the natural widths are compared directly

    process.env.NO_COLOR = '1';
    table(rows(), ['Check', 'Status', 'Detail'], {});
    const withoutColour = colWidths();

    delete process.env.NO_COLOR;
    process.env.CLICOLOR_FORCE = '1';
    table(rows(), ['Check', 'Status', 'Detail'], {});
    const withColour = colWidths();

    expect(withColour).toEqual(withoutColour);
    expect(withColour[1]).toBe(displayWidth('⚠ WARN') + 2);
  });

  it('produces identical column widths for identical content with colour forced on and off', () => {
    const rows = () => [
      { name: 'auth', state: badge('ok', 'ok'), note: 'a longer note with several words' },
      { name: 'api', state: badge('warn', 'warn'), note: 'another, still longer, note' },
    ];
    setEnv('COLUMNS', '120');

    process.env.NO_COLOR = '1';
    table(rows(), ['name', 'state', 'note'], {});
    const withoutColour = colWidths();

    delete process.env.NO_COLOR;
    process.env.CLICOLOR_FORCE = '1';
    table(rows(), ['name', 'state', 'note'], {});
    const withColour = colWidths();

    expect(withColour).toEqual(withoutColour);
  });
});

describe('table cell truncation', () => {
  it('cuts a long path in the middle so both ends survive', () => {
    setEnv('COLUMNS', '40');
    const path = '/srv/very/long/directory/tree/final-segment.ts';
    expect(displayWidth(path)).toBeGreaterThan(30); // it must actually overflow

    table([{ Path: path }], ['Path'], {});
    const cell = cells()[0];
    if (cell === undefined) throw new Error('no cell rendered');

    expect(cell).toContain('…');
    expect(cell.startsWith('/srv/very/long/')).toBe(true);
    expect(cell.endsWith('final-segment.ts')).toBe(true);
  });

  it('cuts a path containing spaces in the middle so both ends survive', () => {
    setEnv('COLUMNS', '40');
    const path = '/Users/me/My Projects/app/.noir/store/abc123-4567-89ab-cdef-0123456789ab.db';
    expect(displayWidth(path)).toBeGreaterThan(40); // it must actually overflow

    table([{ Path: path }], ['Path'], {});
    const cell = cells()[0];
    if (cell === undefined) throw new Error('no cell rendered');
    const contentWidth = (colWidths()[0] ?? 0) - 2;

    expect(cell.startsWith('/Users/')).toBe(true); // leading directory survives
    expect(cell.endsWith('.db')).toBe(true); // final file name survives
    expect(cell).toContain('…');
    expect(displayWidth(cell)).toBeLessThanOrEqual(contentWidth);
  });

  it('leaves a slash-bearing sentence to word wrap, not a middle cut', () => {
    setEnv('COLUMNS', '40');
    const sentence =
      'the spec/plan docs explain why the column must shrink before the table overflows';

    table([{ Note: sentence }], ['Note'], {});
    const cell = cells()[0];
    if (cell === undefined) throw new Error('no cell rendered');

    expect(cell).toBe(sentence); // untouched, so `wordWrap` folds it in the real renderer
    expect(cell).not.toContain('…');
  });

  it('leaves a multi-word cell for word wrap rather than cutting it', () => {
    setEnv('COLUMNS', '60');
    const detail =
      'better-sqlite3 loadable but sqlite-vec native layer missing — search degrades to BM25';

    table(
      [{ Check: 'native deps', Status: 'WARN', Detail: detail }],
      ['Check', 'Status', 'Detail'],
      {},
    );
    const row = cells();

    // The last word must survive: word wrap folds the cell, it does not cut it.
    expect(row[2]).toContain('BM25');
  });
});

describe('badge — colour is applied after truncation', () => {
  it('truncates the label to the requested width and keeps its colour', () => {
    process.env.CLICOLOR_FORCE = '1';
    const plain = '⚠ a very long degraded detail';

    const out = badge('warn', 'a very long degraded detail', 12);

    expect(displayWidth(out)).toBeLessThanOrEqual(12);
    expect(out).toContain('\x1b'); // colour survived the cut
    expect(stripAnsi(out)).toBe(truncateToWidth(plain, 12));
  });

  it('is unchanged when no width is requested', () => {
    process.env.NO_COLOR = '1';
    expect(badge('warn')).toBe('⚠ warn');
    expect(badge('error', 'down')).toBe('✗ down');
  });
});
