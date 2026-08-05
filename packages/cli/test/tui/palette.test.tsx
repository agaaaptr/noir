// B2 + C1 — the command palette overlay + Ctrl+K wiring, driven end-to-end
// through the App with ink-testing-library and a stubbed `dispatch` seam. Same
// stubbed-dispatch + HEALTHY payload pattern as tui.test.tsx; no TTY, no daemon.
//
// Exercises the B2 palette flow (Ctrl+K opens, Esc closes, type + Enter
// dispatches through the deps.dispatch seam, destructive commands route through
// the C1 ConfirmOverlay where `y` approves and `n`/Esc declines) and the B3
// TuiDeps wiring (commands come from the deps, not the App).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusPayload } from '../../src/commands/status.js';
import { App, type TuiDeps } from '../../src/tui/App.js';
import { __setNoirHome, recordRecent } from '../../src/tui/palette/history.js';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

// A representative healthy payload (daemon up, active task) — mirrors tui.test.tsx.
const HEALTHY: StatusPayload = {
  noir: '1.3.0-beta.8',
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

// The palette source the App receives via TuiDeps.commands. `status` is a read
// (no confirm), `context index` is destructive (routes through ConfirmOverlay).
const COMMANDS: readonly PaletteCommand[] = [
  {
    id: 'status',
    label: 'Status',
    argv: ['status'],
    category: 'status',
    keywords: ['status'],
    description: 'project + daemon + store snapshot',
    destructive: false,
  },
  {
    id: 'context index',
    label: 'Context: Index',
    argv: ['context', 'index'],
    category: 'context',
    keywords: ['context', 'index'],
    description: '(re)index project files into the context store',
    destructive: true,
  },
];

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly fetchStatus: ReturnType<typeof vi.fn>;
}

let savedNoColor: string | undefined;
let savedClicolor: string | undefined;
let home: string;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedClicolor = process.env.CLICOLOR_FORCE;
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
  // Isolate the on-disk command history so tests never touch the real ~/.noir.
  home = mkdtempSync(join(tmpdir(), 'noir-tui-palette-'));
  __setNoirHome(home);
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedClicolor === undefined) delete process.env.CLICOLOR_FORCE;
  else process.env.CLICOLOR_FORCE = savedClicolor;
  __setNoirHome(null);
  rmSync(home, { recursive: true, force: true });
});

/** Render the App with a stubbed dispatch + fetchStatus + isolated history. */
function mount(payload: StatusPayload | null = HEALTHY, overrides: Partial<TuiDeps> = {}): Mounted {
  const dispatch = vi.fn(async (): Promise<void> => {});
  const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => payload);
  const deps: TuiDeps = {
    dispatch,
    fetchStatus,
    commands: COMMANDS,
    matcher: handRolledMatcher,
    record: async () => {},
    // Default: empty recents. The C3 test overrides this to exercise the
    // on-disk loader (the App's own default) against the isolated home.
    loadRecent: async () => [],
    ...overrides,
  };
  const element = (
    <App deps={deps} initialPayload={payload} refreshMs={60000} />
  ) as unknown as ReactElement;
  const instance = render(element);
  return { instance, dispatch, fetchStatus };
}

/** Resolve after a short macrotask so React's async state flushes land. */
function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Ctrl+K palette entry', () => {
  it('Ctrl+K from the dashboard opens the palette (Ctrl+letter → key.ctrl && input k)', async () => {
    const m = mount();
    //  = Ctrl+K (parse-keypress maps 0x0b → name 'k', ctrl: true).
    m.instance.stdin.write('');
    await flush(40);
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/Palette/i);
    // The non-destructive command list is rendered.
    expect(frame).toContain('Status');
    m.instance.unmount();
  });
});

describe('palette interaction', () => {
  it('Esc closes the palette back to the dashboard', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write(''); // Esc
    await flush(40);
    const frame = m.instance.lastFrame() ?? '';
    // Back on the dashboard: the /command input hint returns.
    expect(frame).toMatch(/\/command/);
    m.instance.unmount();
  });

  it('typing "stat" + Enter dispatches the matched command through deps.dispatch', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write('stat');
    await flush(40);
    m.instance.stdin.write('\r');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(['status']);
    m.instance.unmount();
  });

  it('a destructive command ("context index") routes through ConfirmOverlay', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write('index');
    await flush(40);
    m.instance.stdin.write('\r');
    await flush(80);
    // Not yet dispatched — the confirm prompt is showing.
    expect(m.dispatch).not.toHaveBeenCalled();
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/y\/N/i);
    m.instance.unmount();
  });

  it('confirm decline (n) does NOT dispatch and returns to the palette', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write('index');
    await flush(40);
    m.instance.stdin.write('\r');
    await flush(80);
    m.instance.stdin.write('n');
    await flush(60);
    expect(m.dispatch).not.toHaveBeenCalled();
    // Back on the palette (the command list is visible again).
    expect(m.instance.lastFrame() ?? '').toContain('Status');
    m.instance.unmount();
  });

  it('confirm decline (Esc) also declines and returns to the palette', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write('index');
    await flush(40);
    m.instance.stdin.write('\r');
    await flush(80);
    m.instance.stdin.write(''); // Esc
    await flush(60);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.instance.lastFrame() ?? '').toContain('Status');
    m.instance.unmount();
  });

  it('confirm approve (y) dispatches the destructive argv and returns to the dashboard', async () => {
    const m = mount();
    m.instance.stdin.write('');
    await flush(40);
    m.instance.stdin.write('index');
    await flush(40);
    m.instance.stdin.write('\r');
    await flush(80);
    m.instance.stdin.write('y');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(['context', 'index']);
    // Back on the dashboard: the /command input hint returns.
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command/);
    m.instance.unmount();
  });
});

describe('recent commands (C3)', () => {
  it('recent commands from the on-disk history render above the full list on an empty query', async () => {
    recordRecent(['status']);
    // Let the App use its DEFAULT (on-disk) loader against the isolated home,
    // so the persisted recents actually flow into the palette.
    const m = mount(HEALTHY, { loadRecent: undefined });
    m.instance.stdin.write('');
    await flush(60);
    const frame = m.instance.lastFrame() ?? '';
    // The recent section header is rendered.
    expect(frame).toMatch(/Recent/i);
    m.instance.unmount();
  });

  it('dispatched commands are recorded via deps.record', async () => {
    const record = vi.fn(async () => {});
    const dispatch = vi.fn(async (): Promise<void> => {});
    const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => HEALTHY);
    const instance = render(
      (
        <App
          deps={
            {
              dispatch,
              fetchStatus,
              commands: COMMANDS,
              matcher: handRolledMatcher,
              record,
              loadRecent: async () => [],
            } satisfies TuiDeps
          }
          initialPayload={HEALTHY}
          refreshMs={60000}
        />
      ) as unknown as ReactElement,
    );
    instance.stdin.write('');
    await flush(40);
    instance.stdin.write('stat');
    await flush(40);
    instance.stdin.write('\r');
    await flush(120);
    expect(dispatch).toHaveBeenCalledWith(['status']);
    expect(record).toHaveBeenCalledWith(['status']);
    instance.unmount();
  });
});
