// `noir tui` dashboard tests. Renders the Ink App with ink-testing-library and
// a stubbed `dispatch` seam (the same `home(opts, deps).dispatch` shape the bin
// wires) so the keybindings + snapshot rendering are exercised without a real
// TTY or a real daemon. Project info / status payloads are supplied directly
// via props (the App's `fetchStatus` is a vi.fn returning a fixed payload), so
// no module-level mocking of `gatherStatusPayload` is needed.

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusPayload } from '../src/commands/status.js';
import { App, type TuiDeps } from '../src/tui/App.js';

// A representative healthy payload (daemon up, active task). The dashboard
// surface is intentionally exercised with optional engines set to null too, so
// the degrade path is covered in a separate fixture below.
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

// Daemon-down + uninitialized: every optional section is null and the daemon
// probe reports `running:false`. The dashboard must render (not throw) and
// surface the down state honestly.
const DAEMON_DOWN: StatusPayload = {
  noir: '1.3.0-beta.8',
  project: { id: 'proj-test', name: 'noir-demo' },
  host: 'claude',
  daemon: { running: false },
  store: null,
  context: null,
  workflow: null,
  memory: null,
};

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly fetchStatus: ReturnType<typeof vi.fn>;
}

let savedNoColor: string | undefined;
let savedClicolor: string | undefined;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedClicolor = process.env.CLICOLOR_FORCE;
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
});

afterEach(() => {
  if (savedNoColor === undefined) delete process.env.NO_COLOR;
  else process.env.NO_COLOR = savedNoColor;
  if (savedClicolor === undefined) delete process.env.CLICOLOR_FORCE;
  else process.env.CLICOLOR_FORCE = savedClicolor;
});

/** Render the App with a stubbed dispatch + fetchStatus. Returns the instance. */
function mount(payload: StatusPayload | null = HEALTHY): Mounted {
  const dispatch = vi.fn(async (): Promise<void> => {});
  const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => payload);
  const deps: TuiDeps = { dispatch, fetchStatus };
  // `initialPayload` short-circuits the first fetch so the very first frame is
  // deterministic. `refreshMs` is large so the interval never fires mid-test.
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

describe('StatusBar — live snapshot summary', () => {
  it('renders host, mode, phase, and daemon from the payload', () => {
    const { instance } = mount(HEALTHY);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('host:');
    expect(frame).toContain('claude');
    expect(frame).toContain('mode:');
    expect(frame).toContain('full');
    expect(frame).toContain('phase:');
    expect(frame).toContain('implement');
    expect(frame).toContain('daemon:');
  });

  it('shows the daemon as up when running', () => {
    const { instance } = mount(HEALTHY);
    expect(instance.lastFrame() ?? '').toContain('up');
  });

  it('degrades cleanly when the daemon is down (running:false)', () => {
    const { instance } = mount(DAEMON_DOWN);
    const frame = instance.lastFrame() ?? '';
    // The daemon cell reads "down"; workflow is null so phase falls back to idle.
    expect(frame).toContain('down');
    expect(frame).toContain('idle');
    // Optional engine sections are rendered (unavailable), never blank space.
    expect(frame).toMatch(/Store:|Context:|Workflow:|Memory:/);
  });
});

describe('CommandInput — /command dispatch via the bin seam', () => {
  it('types a /command and Enter dispatches through deps.dispatch', async () => {
    const m = mount(HEALTHY);
    m.instance.stdin.write('/sync');
    await flush(20); // let React flush the buffer update before Enter
    m.instance.stdin.write('\r');
    await flush(80);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(['sync']);
    m.instance.unmount();
  });

  it('multi-token /command splits into argv (`/context search foo`)', async () => {
    const m = mount(HEALTHY);
    m.instance.stdin.write('/context search foo');
    await flush(20);
    m.instance.stdin.write('\r');
    await flush(80);
    expect(m.dispatch).toHaveBeenCalledWith(['context', 'search', 'foo']);
    m.instance.unmount();
  });

  it('captured dispatched stdout is rendered in the output pane', async () => {
    const dispatch = vi.fn(async (): Promise<void> => {
      process.stdout.write('synced 5 managed files\n');
    });
    const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => HEALTHY);
    const instance = render(
      (
        <App deps={{ dispatch, fetchStatus }} initialPayload={HEALTHY} refreshMs={60000} />
      ) as unknown as ReactElement,
    );
    instance.stdin.write('/sync');
    await flush(20);
    instance.stdin.write('\r');
    await flush(120);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('synced 5 managed files');
    instance.unmount();
  });

  it('bare text (no leading /) does NOT dispatch — shown as a hint', async () => {
    const m = mount(HEALTHY);
    m.instance.stdin.write('hello');
    await flush(20);
    m.instance.stdin.write('\r');
    await flush(80);
    expect(m.dispatch).not.toHaveBeenCalled();
    // The notice names the convention.
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command|hint/i);
    m.instance.unmount();
  });
});

describe('keybindings — quit, help, scroll', () => {
  it('q on an empty buffer quits — subsequent input is ignored (frame frozen)', async () => {
    const m = mount(HEALTHY);
    m.instance.stdin.write('q');
    await flush(80);
    const frameAfterQ = m.instance.lastFrame() ?? '';
    // If the App were still mounted, typing into it would change the frame.
    // A quit dashboard ignores further stdin — the frame stays frozen.
    m.instance.stdin.write('s');
    m.instance.stdin.write('s');
    m.instance.stdin.write('?');
    await flush(60);
    expect(m.instance.lastFrame() ?? '').toBe(frameAfterQ);
    // Dispatch never fired (quit short-circuits before any submit).
    expect(m.dispatch).not.toHaveBeenCalled();
  });

  it('? toggles the help overlay', async () => {
    const { instance } = mount(HEALTHY);
    instance.stdin.write('?');
    await flush(40);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/Keybindings/i);
    expect(frame).toMatch(/press \? \/ Esc \/ q to close/i);
    // The help overlay documents the palette (Ctrl+K) and output search
    // (Ctrl+F, n/N) keybindings added in B2 + C2/C4.
    expect(frame).toMatch(/Ctrl\+K/i);
  });

  it('ArrowDown / ArrowUp move the scroll offset without dispatching', async () => {
    const m = mount(HEALTHY);
    // Multi-line snapshot present; scroll down then up. No dispatch fires.
    m.instance.stdin.write('[B'); // ArrowDown
    m.instance.stdin.write('[B'); // ArrowDown
    m.instance.stdin.write('[A'); // ArrowUp
    await flush(40);
    expect(m.dispatch).not.toHaveBeenCalled();
    m.instance.unmount();
  });
});

describe('NO_COLOR — strips ANSI from the dashboard', () => {
  it('CLICOLOR_FORCE=1 emits ANSI escapes in the dashboard', () => {
    process.env.CLICOLOR_FORCE = '1';
    const { instance } = mount(HEALTHY);
    const frame = instance.lastFrame() ?? '';
    expect(frame).toContain('\x1b['); // ANSI present
    instance.unmount();
  });

  it('NO_COLOR overrides CLICOLOR_FORCE — the frame is plain text', () => {
    process.env.CLICOLOR_FORCE = '1';
    process.env.NO_COLOR = '1';
    const { instance } = mount(HEALTHY);
    const frame = instance.lastFrame() ?? '';
    expect(frame).not.toContain('\x1b['); // no ANSI escapes anywhere
    // Brand text is still readable (the diamond mark survives stripped).
    expect(frame).toContain('noir');
    instance.unmount();
  });
});
