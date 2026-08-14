// v2 — output search now lives in the palette's `output` corpus (Ctrl+F opens
// it; the former standalone search screen merged into the single command
// surface). Driven end-to-end through the App with a stubbed `dispatch` seam.
//
// Flow: dispatch `/sync` (the stub writes multi-line output to stdout, which
// capture.ts collects) → Ctrl+F opens the `output` corpus → typing filters the
// matched lines → Esc returns to the dashboard.
//
// `\x06` is Ctrl+F (parse-keypress maps 0x06 → name 'f', ctrl: true).

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StatusPayload } from '../../src/commands/status.js';
import { App, type TuiDeps } from '../../src/tui/App.js';

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

// Multi-line stdout for the `/sync` dispatch stub.
const SYNC_OUTPUT = ['synced 5 managed files', 'docs are up to date', 'task advanced'].join('\n');

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly dispatch: ReturnType<typeof vi.fn>;
}

function mount(payload: StatusPayload | null = HEALTHY): Mounted {
  const dispatch = vi.fn(async (): Promise<void> => {
    process.stdout.write(`${SYNC_OUTPUT}\n`);
  });
  const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => payload);
  const deps: TuiDeps = { dispatch, fetchStatus };
  const element = (
    <App deps={deps} initialPayload={payload} refreshMs={60000} />
  ) as unknown as ReactElement;
  const instance = render(element);
  return { instance, dispatch };
}

function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dispatch `/status` (non-destructive) and wait for the captured output to land. */
async function runStatus(m: Mounted): Promise<void> {
  m.instance.stdin.write('/status');
  await flush(20);
  m.instance.stdin.write('\r');
  await flush(120);
}

describe('output-pane search via the palette output corpus (v2)', () => {
  it('Ctrl+F opens the output corpus when dispatched output is displayed', async () => {
    const m = mount();
    await runStatus(m);
    expect(m.instance.lastFrame() ?? '').toContain('synced 5 managed files');

    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/output/i); // corpus name in the header
    expect(frame).toContain('synced 5 managed files'); // empty query shows the output
    m.instance.unmount();
  });

  it('typing filters the matched lines; Esc returns to the dashboard', async () => {
    const m = mount();
    await runStatus(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);

    // Type 'ar' → only 'docs are up to date' contains 'ar'.
    m.instance.stdin.write('ar');
    await flush(30);
    let frame = m.instance.lastFrame() ?? '';
    expect(frame).toContain('docs are up to date');
    expect(frame).not.toContain('synced 5 managed files');

    // Esc returns to the dashboard (the /command input hint returns).
    m.instance.stdin.write('\x1b'); // Esc
    await flush(40);
    frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/\/command/);
    m.instance.unmount();
  });

  it('an empty query shows the full output; Esc still exits', async () => {
    const m = mount();
    await runStatus(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    expect(m.instance.lastFrame() ?? '').toContain('task advanced');
    m.instance.stdin.write('\x1b'); // Esc
    await flush(40);
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command/);
    m.instance.unmount();
  });
});
