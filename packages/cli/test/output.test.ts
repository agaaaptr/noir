// S9 t2 — output infra tests. Verifies the S9 stream discipline (data→stdout,
// diagnostics→stderr), the auto-disable matrix for decoration (--json / --quiet
// / CI / NO_COLOR / !TTY), the exit-code contract, and fail()/handleError().
//
// ora + cli-table3 are mocked so assertions are deterministic and do not
// depend on a real TTY or the renderers' internals. picocolors is left real —
// it strips ANSI under !stdout.isTTY (the test default), so plain-text
// substring assertions hold regardless of color support.
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- mocks (hoisted above imports by vitest) -------------------------------
// ora's factory + shared handle are defined via `vi.hoisted` so the `vi.mock`
// factory (which runs before top-level consts are initialized) can safely
// reference them, and the test body can assert against the same handle.
const { oraFactory, oraHandle } = vi.hoisted(() => {
  const handle = {
    text: '',
    start: vi.fn(),
    stop: vi.fn(),
    clear: vi.fn(),
    succeed: vi.fn(),
    fail: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  };
  return { oraFactory: vi.fn((_text: string) => handle), oraHandle: handle };
});

vi.mock('ora', () => ({ default: oraFactory }));

vi.mock('cli-table3', () => ({
  default: class MockTable {
    private readonly rows: string[][] = [];
    constructor(public readonly opts: { head?: string[] }) {}
    push(...rows: string[][]): void {
      for (const r of rows) this.rows.push(r);
    }
    toString(): string {
      const head = this.opts.head ?? [];
      const lines = [head.join(' | ')];
      for (const r of this.rows) lines.push(r.join(' | '));
      return lines.join('\n');
    }
  },
}));

import ora from 'ora';
import {
  type CliOptions,
  EXIT,
  error,
  fail,
  handleError,
  inferExitCode,
  info,
  isInteractive,
  isNoInput,
  json,
  log,
  NoirCliError,
  requireInteractive,
  spinner,
  success,
  table,
  warn,
} from '../src/output.js';

// --- stream capture --------------------------------------------------------
interface Captured {
  out: string;
  err: string;
}
function captureStreams(): { capture: () => Captured; restore: () => void } {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    outChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    errChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  return {
    capture: () => ({ out: outChunks.join(''), err: errChunks.join('') }),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

// --- TTY + env management --------------------------------------------------
let savedCi: string | undefined;
let savedNoColor: string | undefined;
let savedStdoutTty: boolean | undefined;
let savedStdinTty: boolean | undefined;
let savedExitCode: number | string | null | undefined;

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

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  savedCi = process.env.CI;
  savedNoColor = process.env.NO_COLOR;
  savedStdoutTty = process.stdout.isTTY;
  savedStdinTty = process.stdin.isTTY;
  savedExitCode = process.exitCode;
  delete process.env.CI;
  delete process.env.NO_COLOR;
  setTty(false, false); // default: non-TTY (CI-like)
  process.exitCode = undefined;
  vi.clearAllMocks();
});

afterEach(() => {
  setEnv('CI', savedCi);
  setEnv('NO_COLOR', savedNoColor);
  setTty(savedStdoutTty ?? false, savedStdinTty ?? false);
  process.exitCode = savedExitCode as number | undefined;
});

describe('EXIT constants', () => {
  it('exposes the S9 contract 0/1/2/3/4/5', () => {
    expect(EXIT).toEqual({
      OK: 0,
      ERROR: 1,
      USAGE: 2,
      NOT_FOUND: 3,
      DAEMON_DOWN: 4,
      CANCELLED: 5,
    });
  });
});

describe('isInteractive', () => {
  it('true when both streams are TTY and no disablers are set', () => {
    setTty(true, true);
    expect(isInteractive()).toBe(true);
  });

  it.each([
    ['json', { json: true }],
    ['noInput alias', { noInput: true }],
    ['commander input=false', { input: false }],
  ] as [string, CliOptions][])('false when %s is set (TTY present)', (_label, opts) => {
    setTty(true, true);
    expect(isInteractive(opts)).toBe(false);
  });

  it('false when only stdout is a TTY (stdin must be a TTY too)', () => {
    setTty(true, false);
    expect(isInteractive()).toBe(false);
  });

  it('false when only stdin is a TTY', () => {
    setTty(false, true);
    expect(isInteractive()).toBe(false);
  });

  it('false under CI', () => {
    setTty(true, true);
    setEnv('CI', 'true');
    expect(isInteractive()).toBe(false);
  });

  it('false under NO_COLOR', () => {
    setTty(true, true);
    setEnv('NO_COLOR', '1');
    expect(isInteractive()).toBe(false);
  });

  it('CI="0" does NOT disable (explicit opt-out)', () => {
    setTty(true, true);
    setEnv('CI', '0');
    expect(isInteractive()).toBe(true);
  });
});

describe('isNoInput', () => {
  it('honors the noInput alias', () => {
    expect(isNoInput({ noInput: true })).toBe(true);
  });
  it('honors commander input=false', () => {
    expect(isNoInput({ input: false })).toBe(true);
  });
  it('false when input defaults to true', () => {
    expect(isNoInput({ input: true })).toBe(false);
    expect(isNoInput({})).toBe(false);
  });
});

describe('json() — stdout discipline', () => {
  it('writes JSON.stringify(obj) + newline to STDOUT only', () => {
    const { capture, restore } = captureStreams();
    try {
      json({ ok: true, data: [1, 2, 3] });
      const c = capture();
      expect(c.out).toBe(`${JSON.stringify({ ok: true, data: [1, 2, 3] })}\n`);
      expect(c.err).toBe('');
    } finally {
      restore();
    }
  });
});

describe('human diagnostics — stderr + suppression', () => {
  it('log writes plain text to STDERR', () => {
    const { capture, restore } = captureStreams();
    try {
      log('hello');
      expect(capture().err).toContain('hello');
    } finally {
      restore();
    }
  });

  it('info/success suppressed under --quiet and --json', () => {
    for (const opts of [{ quiet: true }, { json: true }] as CliOptions[]) {
      const { capture, restore } = captureStreams();
      try {
        info('i', opts);
        success('s', opts);
        expect(capture().err).toBe('');
      } finally {
        restore();
      }
    }
  });

  it('info/success emitted by default (stderr)', () => {
    const { capture, restore } = captureStreams();
    try {
      info('hey', {});
      success('yay', {});
      const err = capture().err;
      expect(err).toContain('hey');
      expect(err).toContain('yay');
    } finally {
      restore();
    }
  });

  it('warn/error survive --quiet (carry signal)', () => {
    const { capture, restore } = captureStreams();
    try {
      warn('careful', { quiet: true });
      const e1 = capture().err;
      expect(e1).toContain('careful');
    } finally {
      restore();
    }
    const { capture: c2, restore: r2 } = captureStreams();
    try {
      error('broke', { quiet: true });
      expect(c2().err).toContain('broke');
    } finally {
      r2();
    }
  });

  it('warn/error suppressed under --json (keep stdout pristine)', () => {
    const { capture, restore } = captureStreams();
    try {
      warn('w', { json: true });
      error('e', { json: true });
      const c = capture();
      expect(c.err).toBe('');
      expect(c.out).toBe('');
    } finally {
      restore();
    }
  });
});

describe('table() — cli-table3, suppressed under --json', () => {
  it('renders head + rows to STDERR', () => {
    const { capture, restore } = captureStreams();
    try {
      table(
        [
          { name: 'auth', kind: 'fact' },
          { name: 'api', kind: 'pattern' },
        ],
        ['name', 'kind'],
        {},
      );
      const c = capture();
      expect(c.err).toContain('name');
      expect(c.err).toContain('kind');
      expect(c.err).toContain('auth');
      expect(c.err).toContain('fact');
      expect(c.out).toBe('');
    } finally {
      restore();
    }
  });

  it('emits "(no rows)" placeholder when empty', () => {
    const { capture, restore } = captureStreams();
    try {
      table([], ['a'], {});
      expect(capture().err).toContain('no rows');
    } finally {
      restore();
    }
  });

  it('writes NOTHING under --json (data already emitted as JSON)', () => {
    const { capture, restore } = captureStreams();
    try {
      table([{ a: 1 }], ['a'], { json: true });
      const c = capture();
      expect(c.err).toBe('');
      expect(c.out).toBe('');
    } finally {
      restore();
    }
  });
});

describe('spinner() — ora, no-op when non-interactive', () => {
  it('returns a no-op (ora not constructed) when !isInteractive', () => {
    setTty(false, false);
    const sp = spinner('working', {});
    expect(vi.mocked(ora)).not.toHaveBeenCalled();
    // no-op methods never throw and write nothing
    const { capture, restore } = captureStreams();
    try {
      sp.start('x').succeed('done');
      expect(capture().err).toBe('');
      expect(capture().out).toBe('');
    } finally {
      restore();
    }
  });

  it('returns a no-op under --quiet even when interactive', () => {
    setTty(true, true);
    spinner('working', { quiet: true });
    expect(vi.mocked(ora)).not.toHaveBeenCalled();
  });

  it('returns a no-op under --json even when interactive', () => {
    setTty(true, true);
    spinner('working', { json: true });
    expect(vi.mocked(ora)).not.toHaveBeenCalled();
  });

  it('constructs ora with the initial text when interactive', () => {
    setTty(true, true);
    const sp = spinner('indexing…', {});
    expect(vi.mocked(ora)).toHaveBeenCalledWith('indexing…');
    // forwarding: succeed reaches the underlying ora handle
    sp.succeed('done');
    expect(oraHandle.succeed).toHaveBeenCalledWith('done');
  });
});

describe('fail() — exit code + stream routing', () => {
  it('writes the message to STDERR (non-json) and throws a noir CommanderError', () => {
    const { capture, restore } = captureStreams();
    try {
      expect(() => fail(EXIT.DAEMON_DOWN, 'daemon is down', {})).toThrow();
      const c = capture();
      expect(c.err).toContain('daemon is down');
      expect(c.out).toBe('');
    } finally {
      restore();
    }
  });

  it('throws a CommanderError whose exitCode is respected by inferExitCode', () => {
    let caught: unknown;
    try {
      fail(EXIT.DAEMON_DOWN, 'down', {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommanderError);
    expect(inferExitCode(caught)).toBe(EXIT.DAEMON_DOWN);
  });

  it('under --json emits a structured {ok:false,error} envelope to STDOUT', () => {
    const { capture, restore } = captureStreams();
    try {
      expect(() => fail(EXIT.USAGE, 'bad flag', { json: true })).toThrow();
      const c = capture();
      expect(c.out).toContain('"ok":false');
      expect(c.out).toContain('"code":2');
      expect(c.out).toContain('"message":"bad flag"');
      expect(c.err).toBe('');
    } finally {
      restore();
    }
  });
});

describe('requireInteractive — scriptable hard rule', () => {
  it('throws exit 2 (USAGE) when not interactive', () => {
    setTty(false, false);
    let caught: unknown;
    try {
      requireInteractive({}, 'memory save --content');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommanderError);
    expect(inferExitCode(caught)).toBe(EXIT.USAGE);
  });

  it('returns normally when interactive', () => {
    setTty(true, true);
    expect(() => requireInteractive({}, 'x')).not.toThrow();
  });
});

describe('inferExitCode — full mapping', () => {
  it('NoirCliError → its exitCode', () => {
    expect(inferExitCode(new NoirCliError(EXIT.CANCELLED, 'x'))).toBe(EXIT.CANCELLED);
  });

  it('our noir.* CommanderError → its exitCode (not remapped)', () => {
    const err = new CommanderError(EXIT.DAEMON_DOWN, 'noir.error', 'x');
    expect(inferExitCode(err)).toBe(EXIT.DAEMON_DOWN);
  });

  it.each([
    ['helpDisplayed → 0', 'commander.helpDisplayed', EXIT.OK],
    ['versionDisplayed → 0', 'commander.versionDisplayed', EXIT.OK],
    ['unknownCommand → 3', 'commander.unknownCommand', EXIT.NOT_FOUND],
    ['usage error → 2', 'commander.invalidArgument', EXIT.USAGE],
  ] as [string, string, number][])('%s', (_label, code, expected) => {
    expect(inferExitCode(new CommanderError(1, code, 'x'))).toBe(expected);
  });

  it('unknown Error → 1 (ERROR)', () => {
    expect(inferExitCode(new Error('boom'))).toBe(EXIT.ERROR);
    expect(inferExitCode('not even an error')).toBe(EXIT.ERROR);
  });
});

describe('handleError — stderr + process.exitCode', () => {
  it('writes NoirCliError message and sets exitCode', () => {
    const { capture, restore } = captureStreams();
    try {
      handleError(new NoirCliError(EXIT.USAGE, 'bad usage'));
      expect(capture().err).toContain('bad usage');
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(EXIT.USAGE);
  });

  it('prefixes unknown errors with "noir:" and sets exit 1', () => {
    const { capture, restore } = captureStreams();
    try {
      handleError(new Error('kaboom'));
      expect(capture().err).toContain('noir: kaboom');
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(EXIT.ERROR);
  });

  it('does not double-write a CommanderError (commander/fail already wrote it)', () => {
    const { capture, restore } = captureStreams();
    try {
      handleError(new CommanderError(EXIT.USAGE, 'noir.error', 'already written'));
      expect(capture().err).toBe('');
    } finally {
      restore();
    }
    expect(process.exitCode).toBe(EXIT.USAGE);
  });
});
