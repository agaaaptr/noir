// Quiet-mode decoration contract. `output.ts`'s header and the CLI-runtime
// capability doc both promise that decoration (picocolors / cli-table3) turns
// off under `--quiet`; these tests pin that promise for the colour authority
// itself (`useColor` / the `c` palette / `badge`) and for a real cli-table3
// render, and confirm `--json` output stays byte-stable (it never carried
// ANSI today, and must keep not carrying it).
//
// The theme never sees the parsed command options, so the quiet signal reaches
// it the same way every other gate does — through the process environment. The
// CLI's own `preAction` writes `NOIR_QUIET=1` for a `--quiet` invocation (and
// deletes the variable otherwise), mirroring the existing `NOIR_NON_INTERACTIVE`
// bridge. These tests set the variable the CLI would produce and force colour
// on (`CLICOLOR_FORCE=1`) so a stray escape is visible instead of being masked
// by the non-TTY test runner.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { json, table } from '../src/output.js';
import { badge, c, useColor } from '../src/theme.js';

const ROWS = [
  { Check: 'runtime', Status: 'OK', Detail: 'node 20 — healthy' },
  { Check: 'store', Status: 'FAIL', Detail: 'store DB would not open' },
];
const COLS = ['Check', 'Status', 'Detail'];

interface SavedEnv {
  NO_COLOR: string | undefined;
  CLICOLOR_FORCE: string | undefined;
  NOIR_QUIET: string | undefined;
  COLUMNS: string | undefined;
  stdoutColumns: number | undefined;
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
    NOIR_QUIET: process.env.NOIR_QUIET,
    COLUMNS: process.env.COLUMNS,
    stdoutColumns: process.stdout.columns,
  };
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
  delete process.env.FORCE_COLOR;
  delete process.env.NOIR_QUIET;
  delete process.env.COLUMNS;
  // A deterministic width for the table render (mirrors theme.test.ts).
  Object.defineProperty(process.stdout, 'columns', {
    value: 80,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  setEnv('NO_COLOR', saved.NO_COLOR);
  setEnv('CLICOLOR_FORCE', saved.CLICOLOR_FORCE);
  setEnv('NOIR_QUIET', saved.NOIR_QUIET);
  setEnv('COLUMNS', saved.COLUMNS);
  Object.defineProperty(process.stdout, 'columns', {
    value: saved.stdoutColumns,
    configurable: true,
    writable: true,
  });
});

function capture(stream: NodeJS.WriteStream): { read: () => string; restore: () => void } {
  const chunks: string[] = [];
  const orig = stream.write.bind(stream);
  stream.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof stream.write;
  return {
    read: () => chunks.join(''),
    restore: () => {
      stream.write = orig;
    },
  };
}

describe('useColor — quiet mode', () => {
  it('reports colour OFF for a quiet run even when colour is forced', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NOIR_QUIET = '1';
    expect(useColor()).toBe(false);
  });

  it('still lets CLICOLOR_FORCE force colour when the run is not quiet', () => {
    process.env.CLICOLOR_FORCE = '1';
    expect(useColor()).toBe(true);
  });

  it('treats any non-empty NOIR_QUIET value as quiet (NO_COLOR-style presence)', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NOIR_QUIET = 'any-value';
    expect(useColor()).toBe(false);
  });
});

describe('palette + badge — quiet mode', () => {
  it('c.* returns plain text under quiet (no ANSI even with colour forced)', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NOIR_QUIET = '1';
    expect(c.ok('x')).toBe('x');
    expect(c.error('y')).toBe('y');
    expect(c.bold(c.info('z'))).toBe('z');
  });

  it('badge() stays symbol+text and uncoloured under quiet', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NOIR_QUIET = '1';
    const out = badge('error', 'down');
    expect(out).toMatch(/✗.*down/);
    expect(out.includes('\x1b')).toBe(false);
  });
});

describe('table — quiet mode', () => {
  it('renders with no ANSI escapes under quiet (headers + body plain)', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NOIR_QUIET = '1';
    const { read, restore } = capture(process.stderr);
    try {
      table(ROWS, COLS, { quiet: true });
      const out = read();
      expect(out.includes('\x1b')).toBe(false);
      expect(out).toContain('Check');
      expect(out).toContain('store');
    } finally {
      restore();
    }
  });

  it('still colours the header when colour is forced and the run is not quiet', () => {
    process.env.CLICOLOR_FORCE = '1';
    const { read, restore } = capture(process.stderr);
    try {
      table(ROWS, COLS, {});
      expect(read().includes('\x1b[36m')).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('--json stays byte-stable', () => {
  it('a --json table writes nothing and json() emits plain, unescaped JSON', () => {
    // Adversarial: colour is forced on, yet --json still carries no ANSI.
    process.env.CLICOLOR_FORCE = '1';
    const err = capture(process.stderr);
    const out = capture(process.stdout);
    try {
      table(ROWS, COLS, { json: true });
      expect(err.read()).toBe('');
      json({ ok: true, n: 1 });
      const o = out.read();
      expect(o).toBe('{"ok":true,"n":1}\n');
      expect(o.includes('\x1b')).toBe(false);
    } finally {
      err.restore();
      out.restore();
    }
  });
});
