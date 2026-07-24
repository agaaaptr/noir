// S9 t4 — `noir` (bare) home menu tests. @clack/prompts is mocked so the
// interactive select/text/cancel flows are deterministic and never touch the
// real stdin; the bin-provided `dispatch` callback is a vi.fn double. These pin
// the three routing arms (interactive menu, --json → `status --json`,
// non-interactive human → `status`) plus per-choice dispatch argv, the inline
// recall-query prompt, and the Ctrl+C → exit 5 (CANCELLED) contract.
import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// @clack/prompts mock. `select`/`text` return values are configured per-test;
// `isCancel` recognises the CANCEL sentinel so cancel flows are deterministic.
const { clackMock, CANCEL } = vi.hoisted(() => {
  const CANCEL = Symbol('cancel');
  return {
    CANCEL,
    clackMock: {
      intro: vi.fn(),
      outro: vi.fn(),
      cancel: vi.fn(),
      select: vi.fn(),
      text: vi.fn(),
      isCancel: vi.fn((v: unknown) => v === CANCEL),
    },
  };
});

vi.mock('@clack/prompts', () => clackMock);

// loadProjectInfo is mocked so tryProject() is deterministic (no test-cwd
// coupling to whether the real repo is initialized).
vi.mock('@noir-ai/core', () => ({
  loadProjectInfo: vi.fn(() => {
    throw new Error('not initialized');
  }),
}));

import { type HomeDeps, home } from '../src/commands/home.js';
import { EXIT } from '../src/output.js';

// --- TTY + env management (isInteractive = stdin&stdout TTY && !CI && !NO_COLOR)
let savedCi: string | undefined;
let savedNoColor: string | undefined;
let savedStdoutTty: boolean | undefined;
let savedStdinTty: boolean | undefined;

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
  delete process.env.CI;
  delete process.env.NO_COLOR;
  setTty(false, false); // default non-interactive
  vi.clearAllMocks();
});

afterEach(() => {
  setEnv('CI', savedCi);
  setEnv('NO_COLOR', savedNoColor);
  setTty(savedStdoutTty ?? false, savedStdinTty ?? false);
});

function makeDeps(): HomeDeps & {
  dispatch: ReturnType<typeof vi.fn>;
} {
  return {
    dispatch: vi.fn(async () => {}),
  };
}

describe('home — non-interactive routing (scriptable)', () => {
  it('--json → dispatch(["status","--json"])', async () => {
    const deps = makeDeps();
    await home({ json: true }, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status', '--json']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('no json + non-TTY → dispatch(["status"]) (I2: status is probe-only, safe bare)', async () => {
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('--no-input forces non-interactive even with a TTY → dispatch(["status"])', async () => {
    setTty(true, true);
    const deps = makeDeps();
    await home({ input: false }, deps); // --no-input
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });
});

describe('home — interactive @clack menu', () => {
  beforeEach(() => {
    setTty(true, true); // interactive
  });

  it('intro + select are shown, "status" dispatches ["status"]', async () => {
    clackMock.select.mockResolvedValue('status');
    const deps = makeDeps();
    await home({}, deps);
    expect(clackMock.intro).toHaveBeenCalledTimes(1);
    expect(clackMock.select).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.outro).toHaveBeenCalledWith('done');
  });

  it.each([
    ['index', ['context', 'index']],
    ['next', ['task', 'next']],
    ['daemon', ['daemon', 'start']],
    ['sync', ['sync']],
  ] as [string, string[]][])('choice %s dispatches %j', async (choice, argv) => {
    clackMock.select.mockResolvedValue(choice);
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(argv);
  });

  it('"recall" prompts for a query then dispatches ["memory","recall",<q>]', async () => {
    clackMock.select.mockResolvedValue('recall');
    clackMock.text.mockResolvedValue('auth flow');
    const deps = makeDeps();
    await home({}, deps);
    expect(clackMock.text).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['memory', 'recall', 'auth flow']);
  });

  it('"exit" does NOT dispatch; outro("bye")', async () => {
    clackMock.select.mockResolvedValue('exit');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });

  it('select cancel (Ctrl+C) → cancel() + exit 5 (CANCELLED), no dispatch', async () => {
    clackMock.select.mockResolvedValue(CANCEL);
    const deps = makeDeps();
    let caught: unknown;
    try {
      await home({}, deps);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CommanderError);
    expect((caught as CommanderError).exitCode).toBe(EXIT.CANCELLED);
    expect(clackMock.cancel).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('recall text cancel → exit 5 (CANCELLED)', async () => {
    clackMock.select.mockResolvedValue('recall');
    clackMock.text.mockResolvedValue(CANCEL);
    const deps = makeDeps();
    await expect(home({}, deps)).rejects.toMatchObject({ exitCode: EXIT.CANCELLED });
    expect(clackMock.cancel).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });
});
