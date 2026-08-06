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
      selectKey: vi.fn(),
      confirm: vi.fn(),
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
  readInstallRecord: vi.fn(() => null),
}));

import { type HomeDeps, home, shouldShowMigrationBanner } from '../src/commands/home.js';
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

// The live palette commands the menu resolves its sections against. Mirrors
// what bin.ts injects as HomeDeps.commands (a subset is enough for tests).
const TEST_COMMANDS = [
  {
    id: 'status',
    label: 'Status',
    argv: ['status'],
    description: 'snapshot',
    category: 'status',
    keywords: ['status'],
    destructive: false,
  },
  {
    id: 'context index',
    label: 'Context: Index',
    argv: ['context', 'index'],
    description: 'index',
    category: 'context',
    keywords: ['context', 'index'],
    destructive: true,
  },
  {
    id: 'memory recall',
    label: 'Memory: Recall',
    argv: ['memory', 'recall'],
    description: 'recall',
    category: 'memory',
    keywords: ['memory', 'recall'],
    destructive: false,
  },
  {
    id: 'task next',
    label: 'Task: Next',
    argv: ['task', 'next'],
    description: 'next',
    category: 'task',
    keywords: ['task', 'next'],
    destructive: false,
  },
  {
    id: 'tui',
    label: 'Dashboard',
    argv: ['tui'],
    description: 'dashboard',
    category: 'dashboard',
    keywords: ['tui'],
    destructive: false,
  },
  {
    id: 'palette',
    label: 'All commands',
    argv: ['palette'],
    description: 'palette',
    category: 'dashboard',
    keywords: ['palette'],
    destructive: false,
  },
] as const;

function makeDeps(): HomeDeps & {
  dispatch: ReturnType<typeof vi.fn>;
} {
  return {
    dispatch: vi.fn(async () => {}),
    commands: [...TEST_COMMANDS],
  };
}

/** Drive the grouped menu: pick a section (selectKey) then an action (select). */
async function pickSectionAndAction(sectionId: string, actionId: string): Promise<void> {
  clackMock.selectKey.mockResolvedValue(sectionId);
  clackMock.select.mockResolvedValue(actionId);
}

describe('home — non-interactive routing (scriptable)', () => {
  it('--json → dispatch(["status","--json"])', async () => {
    const deps = makeDeps();
    await home({ json: true }, deps);
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status', '--json']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('no json + non-TTY → dispatch(["status"]) (status is probe-only, safe bare)', async () => {
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

// TUI policy — `--no-tui` (opts.tui === false) forces the non-interactive
// `status` path even when isInteractive() would be true (a TTY). `--tui`
// (opts.tui === true) is advisory only — it still requires a TTY, so a non-TTY
// run stays on the non-interactive path. Auto (no flag) preserves S9 behavior.
describe('home — TUI policy routing', () => {
  it('--no-tui forces dispatch(["status"]) even in a TTY (no menu)', async () => {
    setTty(true, true); // interactive by TTY alone
    const deps = makeDeps();
    await home({ tui: false }, deps); // --no-tui
    expect(deps.dispatch).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('--no-tui + --json → dispatch(["status","--json"]) even in a TTY', async () => {
    setTty(true, true);
    const deps = makeDeps();
    await home({ tui: false, json: true }, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['status', '--json']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('--tui in a TTY runs the menu (advisory hint, TTY honored)', async () => {
    setTty(true, true);
    clackMock.selectKey.mockResolvedValue('status');
    clackMock.select.mockResolvedValue('status');
    const deps = makeDeps();
    await home({ tui: true }, deps);
    expect(clackMock.selectKey).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
  });

  it('--tui WITHOUT a TTY still routes to dispatch(["status"]) (hint cannot force a menu)', async () => {
    setTty(false, false); // non-interactive
    const deps = makeDeps();
    await home({ tui: true }, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.select).not.toHaveBeenCalled();
  });

  it('auto (no flag) preserves S9 behavior — menu in a TTY, status without one', async () => {
    setTty(true, true);
    clackMock.selectKey.mockResolvedValue('exit');
    const deps = makeDeps();
    await home({}, deps);
    expect(clackMock.selectKey).toHaveBeenCalledTimes(1);
  });
});

describe('home — interactive grouped @clack menu', () => {
  beforeEach(() => {
    setTty(true, true); // interactive
  });

  it('intro + selectKey (section picker) are shown, "status" dispatches ["status"]', async () => {
    await pickSectionAndAction('status', 'status');
    const deps = makeDeps();
    await home({}, deps);
    expect(clackMock.intro).toHaveBeenCalledTimes(1);
    // Level 1 = selectKey (section), Level 2 = select (action).
    expect(clackMock.selectKey).toHaveBeenCalledTimes(1);
    expect(clackMock.select).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['status']);
    expect(clackMock.outro).toHaveBeenCalledWith('done');
  });

  it('section "status" → action "context index" dispatches ["context","index"] (destructive: confirm first)', async () => {
    await pickSectionAndAction('status', 'context index');
    clackMock.confirm.mockResolvedValue(true);
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['context', 'index']);
    expect(clackMock.confirm).toHaveBeenCalledTimes(1); // destructive gate
  });

  it('a declined destructive action does NOT dispatch (stays in the section, can back out)', async () => {
    // Open "status", select the destructive "context index" → decline the
    // confirm → the loop stays in the section; then the user picks "back" →
    // returns to the section picker → Exit.
    clackMock.selectKey.mockResolvedValueOnce('status').mockResolvedValueOnce('exit');
    clackMock.select.mockResolvedValueOnce('context index').mockResolvedValueOnce('back');
    clackMock.confirm.mockResolvedValue(false); // decline
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });

  it('"memory recall" prompts for a query then dispatches ["memory","recall",<q>]', async () => {
    await pickSectionAndAction('memory', 'memory recall');
    clackMock.text.mockResolvedValue('auth flow');
    const deps = makeDeps();
    await home({}, deps);
    expect(clackMock.text).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).toHaveBeenCalledWith(['memory', 'recall', 'auth flow']);
  });

  it('section "dashboard" → "tui" dispatches ["tui"] (launches the full-screen dashboard)', async () => {
    await pickSectionAndAction('dashboard', 'tui');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['tui']);
  });

  it('section "dashboard" → "palette" dispatches ["palette"] (fuzzy command palette)', async () => {
    await pickSectionAndAction('dashboard', 'palette');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['palette']);
  });

  it('"Exit" at the section picker does NOT dispatch; outro("bye")', async () => {
    clackMock.selectKey.mockResolvedValue('exit');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });

  it('Esc at the action list → back to the section picker (no dispatch)', async () => {
    // User opens "memory", then cancels the action list (selectKey = memory,
    // select = CANCEL) → loop returns to the picker; then Exit.
    clackMock.selectKey.mockResolvedValueOnce('memory').mockResolvedValueOnce('exit');
    clackMock.select.mockResolvedValue(CANCEL);
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(clackMock.selectKey).toHaveBeenCalledTimes(2);
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });

  it('selectKey cancel (Ctrl+C at the picker) → cancel() + exit 5 (CANCELLED)', async () => {
    clackMock.selectKey.mockResolvedValue(CANCEL);
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
    await pickSectionAndAction('memory', 'memory recall');
    clackMock.text.mockResolvedValue(CANCEL);
    const deps = makeDeps();
    await expect(home({}, deps)).rejects.toMatchObject({ exitCode: EXIT.CANCELLED });
    expect(clackMock.cancel).toHaveBeenCalledTimes(1);
    expect(deps.dispatch).not.toHaveBeenCalled();
  });

  it('navigation: "next" from a section jumps to the next section', async () => {
    // Open "status", select "next" (→ next section = memory), then pick an action there.
    clackMock.selectKey.mockResolvedValue('status');
    clackMock.select.mockResolvedValueOnce('next').mockResolvedValueOnce('memory recall');
    clackMock.text.mockResolvedValue('q');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).toHaveBeenCalledWith(['memory', 'recall', 'q']);
  });

  it('navigation: "back" returns to the section picker', async () => {
    clackMock.selectKey.mockResolvedValueOnce('memory').mockResolvedValueOnce('exit');
    clackMock.select.mockResolvedValue('back');
    const deps = makeDeps();
    await home({}, deps);
    expect(deps.dispatch).not.toHaveBeenCalled();
    expect(clackMock.selectKey).toHaveBeenCalledTimes(2);
    expect(clackMock.outro).toHaveBeenCalledWith('bye');
  });
});

describe('shouldShowMigrationBanner', () => {
  it('shows once for a non-native method, not for native', () => {
    expect(
      shouldShowMigrationBanner(
        { method: 'npm', version: '1.6.0', channel: 'latest', installedAt: 'x' },
        '1.6.0',
      ),
    ).toBe(true);
    expect(
      shouldShowMigrationBanner(
        { method: 'native', version: '1.6.0', channel: 'latest', installedAt: 'x' },
        '1.6.0',
      ),
    ).toBe(false);
  });

  // C1 hardening (brief Step 2): banner dismissal persists per version.
  it('returns false when the current version is in dismissedVersions', () => {
    expect(
      shouldShowMigrationBanner(
        {
          method: 'npm',
          version: '1.6.0',
          channel: 'latest',
          installedAt: 'x',
          dismissedVersions: ['1.6.0'],
        },
        '1.6.0',
      ),
    ).toBe(false);
  });
  it('returns true again after an upgrade (new version not yet dismissed)', () => {
    // Dismissed for 1.6.0, but the user upgraded to 1.7.0 → nudge once more.
    expect(
      shouldShowMigrationBanner(
        {
          method: 'npm',
          version: '1.6.0',
          channel: 'latest',
          installedAt: 'x',
          dismissedVersions: ['1.6.0'],
        },
        '1.7.0',
      ),
    ).toBe(true);
  });
  it('absent dismissedVersions ⇒ show (backward-compatible with older records)', () => {
    expect(
      shouldShowMigrationBanner(
        { method: 'npm', version: '1.6.0', channel: 'latest', installedAt: 'x' },
        '1.6.0',
      ),
    ).toBe(true);
  });
});
