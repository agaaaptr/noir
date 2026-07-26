// SP-C — buildConflictOpts (TDD). Interactivity is driven by real TTY/env
// state (set per-test, like home.test.ts) — no mocks.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildConflictOpts } from '../src/conflict.js';

let savedCi: string | undefined;
let savedNoColor: string | undefined;
let savedStdoutTty: boolean | undefined;
let savedStdinTty: boolean | undefined;
let savedNoirNi: string | undefined;

function setTty(stdout: boolean, stdin: boolean): void {
  Object.defineProperty(process.stdout, 'isTTY', {
    value: stdout,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(process.stdin, 'isTTY', {
    value: stdin,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  savedCi = process.env.CI;
  savedNoColor = process.env.NO_COLOR;
  savedStdoutTty = process.stdout.isTTY;
  savedStdinTty = process.stdin.isTTY;
  savedNoirNi = process.env.NOIR_NON_INTERACTIVE;
  delete process.env.CI;
  delete process.env.NO_COLOR;
  delete process.env.NOIR_NON_INTERACTIVE;
  setTty(false, false);
});

afterEach(() => {
  if (savedCi === undefined) delete process.env.CI;
  else process.env.CI = savedCi;
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedNoirNi === undefined) delete process.env.NOIR_NON_INTERACTIVE;
  else process.env.NOIR_NON_INTERACTIVE = savedNoirNi;
  setTty(savedStdoutTty ?? false, savedStdinTty ?? false);
});

describe('buildConflictOpts (SP-C)', () => {
  it('force=true → overwrite policy, no prompt', () => {
    const o = buildConflictOpts({ force: true });
    expect(o.conflictPolicy).toBe('overwrite');
    expect(o.onConflict).toBeUndefined();
  });

  it('non-interactive (non-TTY) → preserve policy, no prompt', () => {
    setTty(false, false);
    const o = buildConflictOpts({});
    expect(o.conflictPolicy).toBe('preserve');
    expect(o.onConflict).toBeUndefined();
  });

  it('interactive TTY → preserve policy + onConflict resolver wired', () => {
    setTty(true, true);
    const o = buildConflictOpts({});
    expect(o.conflictPolicy).toBe('preserve');
    expect(typeof o.onConflict).toBe('function');
  });

  it('force wins even in a TTY (no prompt)', () => {
    setTty(true, true);
    const o = buildConflictOpts({ force: true });
    expect(o.conflictPolicy).toBe('overwrite');
    expect(o.onConflict).toBeUndefined();
  });

  it('NOIR_NON_INTERACTIVE set (--json/--no-input) ⇒ preserve even in a TTY (SP-G)', () => {
    setTty(true, true);
    process.env.NOIR_NON_INTERACTIVE = '1';
    const o = buildConflictOpts({});
    expect(o.conflictPolicy).toBe('preserve');
    expect(o.onConflict).toBeUndefined();
  });
});
