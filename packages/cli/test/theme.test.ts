// Design-system tests. Covers the theme module (badge / useColor /
// terminalWidth / accessibleMode) AND the real cli-table3 rendering of `table()`
// (the existing output.test.ts MOCKS cli-table3, so it can't exercise the actual
// header-color / responsive-width behavior these tests exist to lock down).
//
// What MUST hold:
//   - badge() ALWAYS returns SYMBOL + TEXT LABEL — the accessibility invariant
//     (NO_COLOR and colorblind users get the same information as a sighted user).
//   - table() NEVER paints a header red (RED is reserved for ERROR), and strips
//     ALL ANSI under NO_COLOR (no @colors/colors leak from cli-table3).
//   - table() never overflows the terminal at 60 / 80 / 120 columns.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { table } from '../src/output.js';
import { accessibleMode, badge, c, terminalWidth, useColor } from '../src/theme.js';

// --- stream capture (stderr is where table() writes) -----------------------
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

// --- env + TTY management ---------------------------------------------------
interface SavedEnv {
  NO_COLOR: string | undefined;
  CLICOLOR_FORCE: string | undefined;
  COLUMNS: string | undefined;
  NOIR_ACCESSIBLE: string | undefined;
  stdoutColumns: number | undefined;
  stdoutTty: boolean | undefined;
}

let saved: SavedEnv;

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  saved = {
    NO_COLOR: process.env.NO_COLOR,
    CLICOLOR_FORCE: process.env.CLICOLOR_FORCE,
    COLUMNS: process.env.COLUMNS,
    NOIR_ACCESSIBLE: process.env.NOIR_ACCESSIBLE,
    stdoutColumns: process.stdout.columns,
    stdoutTty: process.stdout.isTTY,
  };
  // Start each test from a clean baseline (no color env, no COLUMNS override).
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
  delete process.env.COLUMNS;
  delete process.env.NOIR_ACCESSIBLE;
  // Force a deterministic terminal width for the non-COLUMNS tests.
  Object.defineProperty(process.stdout, 'columns', {
    value: 80,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  setEnv('NO_COLOR', saved.NO_COLOR);
  setEnv('CLICOLOR_FORCE', saved.CLICOLOR_FORCE);
  setEnv('COLUMNS', saved.COLUMNS);
  setEnv('NOIR_ACCESSIBLE', saved.NOIR_ACCESSIBLE);
  Object.defineProperty(process.stdout, 'columns', {
    value: saved.stdoutColumns,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    value: saved.stdoutTty,
    configurable: true,
    writable: true,
  });
});

describe('badge — symbol + text-label invariant', () => {
  it('each state pairs its symbol with the state name by default', () => {
    expect(badge('ok')).toMatch(/✓.*ok/);
    expect(badge('warn')).toMatch(/⚠.*warn/);
    expect(badge('error')).toMatch(/✗.*error/);
    expect(badge('info')).toMatch(/ℹ.*info/);
  });

  it('carries a caller-supplied label verbatim alongside the symbol', () => {
    expect(badge('warn', 'degraded')).toMatch(/⚠.*degraded/);
    expect(badge('error', 'down')).toMatch(/✗.*down/);
    expect(badge('ok', 'healthy')).toMatch(/✓.*healthy/);
    expect(badge('info', 'running')).toMatch(/ℹ.*running/);
  });

  it('ALWAYS carries symbol + text under NO_COLOR (colorblind-safe)', () => {
    process.env.NO_COLOR = '1';
    for (const state of ['ok', 'warn', 'error', 'info'] as const) {
      const out = badge(state);
      // Symbol present, text label present, and ZERO ANSI (NO_COLOR strips all).
      expect(out).toMatch(/[✓⚠✗ℹ]/);
      expect(out).toContain(state);
      expect(out.includes('\x1b')).toBe(false);
    }
  });

  it('emits ANSI color when CLICOLOR_FORCE=1 (decoration is real but off-path)', () => {
    process.env.CLICOLOR_FORCE = '1';
    expect(badge('ok').includes('\x1b')).toBe(true);
    expect(badge('error').includes('\x1b')).toBe(true);
    // Still carries the symbol + text underneath the color.
    expect(badge('warn', 'degraded')).toMatch(/⚠.*degraded/);
  });

  it('c.* methods strip to plain text under NO_COLOR', () => {
    process.env.NO_COLOR = '1';
    expect(c.ok('x')).toBe('x');
    expect(c.error('y')).toBe('y');
    expect(c.bold(c.info('z'))).toBe('z');
  });
});

describe('useColor — env gates', () => {
  it('NO_COLOR ⇒ false (any non-empty value)', () => {
    process.env.NO_COLOR = '1';
    expect(useColor()).toBe(false);
    process.env.NO_COLOR = 'any-text';
    expect(useColor()).toBe(false);
  });

  it('CLICOLOR_FORCE=1 ⇒ true (forces color on a redirected stream)', () => {
    // Non-TTY stdout, no other enabler — only CLICOLOR_FORCE flips it on.
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    process.env.CLICOLOR_FORCE = '1';
    expect(useColor()).toBe(true);
  });

  it('NO_COLOR wins over CLICOLOR_FORCE (disable is authoritative)', () => {
    process.env.NO_COLOR = '1';
    process.env.CLICOLOR_FORCE = '1';
    expect(useColor()).toBe(false);
  });
});

describe('terminalWidth', () => {
  it('honors COLUMNS when set to a positive integer', () => {
    process.env.COLUMNS = '100';
    expect(terminalWidth()).toBe(100);
  });

  it('falls back when COLUMNS is non-numeric', () => {
    process.env.COLUMNS = 'wide';
    Object.defineProperty(process.stdout, 'columns', { value: 72, configurable: true });
    expect(terminalWidth()).toBe(72);
  });

  it('defaults to 80 when neither COLUMNS nor stdout.columns is set', () => {
    process.env.COLUMNS = '';
    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
    expect(terminalWidth()).toBe(80);
  });

  it('floors a too-small width at 20 (degenerate-shell guard)', () => {
    process.env.COLUMNS = '5';
    expect(terminalWidth()).toBe(20);
  });
});

describe('accessibleMode', () => {
  it('false by default', () => {
    expect(accessibleMode()).toBe(false);
  });
  it('true when NOIR_ACCESSIBLE is set (non-empty)', () => {
    process.env.NOIR_ACCESSIBLE = '1';
    expect(accessibleMode()).toBe(true);
  });
});

describe('table — cli-table3 rendering invariants (real, unmocked)', () => {
  // Two columns: a narrow fixed label and a wide free-text body (the shape that
  // used to go red + overflow). Rows are sized to force word-wrap under narrow
  // terminals and full-width rendering under wide ones.
  const rows = [
    { Check: 'runtime', Status: 'OK', Detail: 'node 20 — healthy' },
    {
      Check: 'native deps',
      Status: 'WARN',
      Detail:
        'better-sqlite3 loadable but sqlite-vec native layer missing — search degrades to BM25',
    },
    { Check: 'store', Status: 'FAIL', Detail: 'store DB would not open' },
  ];
  const cols = ['Check', 'Status', 'Detail'];

  it('NEVER paints a header (or any cell) red — red is reserved for ERROR', () => {
    process.env.CLICOLOR_FORCE = '1'; // force color ON so any red WOULD show
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      // No bright/normal red foreground anywhere (the old default header bug).
      expect(out.includes('\x1b[31m')).toBe(false);
      expect(out.includes('\x1b[91m')).toBe(false);
    } finally {
      restore();
    }
  });

  it('strips ALL ANSI under NO_COLOR (no @colors/colors leak)', () => {
    process.env.NO_COLOR = '1';
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      expect(out.includes('\x1b')).toBe(false);
      // Headers + cells still render as plain text.
      expect(out).toContain('Check');
      expect(out).toContain('Status');
      expect(out).toContain('Detail');
      expect(out).toContain('native deps');
    } finally {
      restore();
    }
  });

  it('header is colored (cyan+bold via picocolors) when color is forced', () => {
    process.env.CLICOLOR_FORCE = '1';
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      // Cyan foreground present on the header line (picocolors emits \x1b[36m).
      expect(out.includes('\x1b[36m')).toBe(true);
      expect(out).toContain('Check');
    } finally {
      restore();
    }
  });

  it.each([60, 80, 120] as const)('never overflows the terminal at %i columns', (width) => {
    process.env.COLUMNS = String(width);
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      const widest = Math.max(...out.split('\n').map((l) => l.length));
      // The whole table must fit the terminal (no line longer than COLUMNS).
      expect(widest).toBeLessThanOrEqual(width);
    } finally {
      restore();
    }
  });

  it('header row stays on a single line (no wrapped header labels)', () => {
    process.env.COLUMNS = '60';
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      // Find the line carrying the 'Check' header — it must ALSO contain 'Status'
      // and 'Detail' (a wrapped header would split them across lines).
      const headerLine = out.split('\n').find((l) => l.includes('Check'));
      expect(headerLine).toBeDefined();
      expect(headerLine).toContain('Status');
      expect(headerLine).toContain('Detail');
    } finally {
      restore();
    }
  });

  it('word-wraps the wide free-text column instead of truncating it', () => {
    process.env.COLUMNS = '60'; // narrow → the Detail column must wrap
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, {});
      const out = read();
      // The long detail sentence is NOT truncated mid-token: its tail
      // ("BM25") still appears somewhere in the rendered output.
      expect(out).toContain('BM25');
    } finally {
      restore();
    }
  });

  it('writes nothing under --json (stdout stays pristine)', () => {
    const { read, restore } = captureStderr();
    try {
      table(rows, cols, { json: true });
      expect(read()).toBe('');
    } finally {
      restore();
    }
  });
});
