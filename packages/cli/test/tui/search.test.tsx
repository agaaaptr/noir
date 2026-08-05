// C2 + C4 — output-pane search (Ctrl+F, n/N), driven end-to-end through the App
// with ink-testing-library and a stubbed `dispatch` seam. Same stubbed-dispatch
// + HEALTHY payload pattern as tui.test.tsx; no TTY, no daemon.
//
// Exercise the flow: dispatch `/sync` (the stub writes multi-line output to
// stdout, which capture.ts collects into the output pane) → Ctrl+F enters search
// mode → typing appends to the query and filters the matches → n / Enter advance
// the active match (wrapping), N steps back → Esc returns to the dashboard.
//
// Key-collision note (resolves spec T7 '/' ambiguity): the dashboard input uses
// '/' as the dispatch prefix, so '/' can never enter search — Ctrl+F is the
// entry key, matching the footer + help hints. `\x06` is Ctrl+F (parse-keypress
// maps 0x06 → name 'f', ctrl: true).
//
// Match arithmetic used by the assertions (case-insensitive includes):
//   query 'a'  → lines 0,1,2 (managed / are·date / advanced) → 3 matches
//   query 'ar' → line 1 only (docs are up to date)            → 1 match
//   empty query → no matches

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StatusPayload } from '../../src/commands/status.js';
import { App, type TuiDeps } from '../../src/tui/App.js';

// A representative healthy payload — mirrors tui.test.tsx.
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

// Multi-line stdout for the `/sync` dispatch stub. Each line has a distinct 'a'
// count so match order is line order.
const SYNC_OUTPUT = ['synced 5 managed files', 'docs are up to date', 'task advanced'].join('\n');

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly dispatch: ReturnType<typeof vi.fn>;
}

/**
 * Render the App with a `/sync` dispatch stub that writes multi-line output to
 * stdout (capture.ts collects it into the output pane) and a fixed payload.
 */
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

/** Resolve after a short macrotask so React's async state flushes land. */
function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dispatch `/sync` and wait for the captured output to land in the pane. */
async function runSync(m: Mounted): Promise<void> {
  m.instance.stdin.write('/sync');
  await flush(20);
  m.instance.stdin.write('\r');
  await flush(120);
}

describe('output-pane search (C2)', () => {
  it('Ctrl+F enters search mode when dispatched output is displayed', async () => {
    const m = mount();
    await runSync(m);
    expect(m.instance.lastFrame() ?? '').toContain('synced 5 managed files');

    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    const frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/search/i);
    // An empty query has no matches yet — the prompt explains that + Esc exits.
    expect(frame).toMatch(/no matches/);
    m.instance.unmount();
  });

  it('typing filters matches and moves the active match; Esc exits to the dashboard', async () => {
    const m = mount();
    await runSync(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);

    // Type 'a' → 3 matches, active auto-lands on the first (1/3).
    m.instance.stdin.write('a');
    await flush(30);
    expect(m.instance.lastFrame() ?? '').toMatch(/1\/3/);

    // Type 'r' → query 'ar' filters to a single match (1/1).
    m.instance.stdin.write('r');
    await flush(30);
    let frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/1\/1/);

    // n wraps (still 1/1 with a single match); N steps back (wraps too).
    m.instance.stdin.write('n');
    await flush(30);
    m.instance.stdin.write('N');
    await flush(30);
    frame = m.instance.lastFrame() ?? '';
    expect(frame).toMatch(/1\/1/);

    // Esc returns to the dashboard (the /command input hint returns).
    m.instance.stdin.write('\x1b'); // Esc
    await flush(40);
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command/);
    m.instance.unmount();
  });

  it('n advances through multiple matches wrapping at the end; N steps back', async () => {
    const m = mount();
    await runSync(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    m.instance.stdin.write('a'); // query 'a' → 3 matches
    await flush(30);

    // n → 2/3; n → 3/3; n → wraps to 1/3.
    m.instance.stdin.write('n');
    await flush(20);
    expect(m.instance.lastFrame() ?? '').toMatch(/2\/3/);
    m.instance.stdin.write('n');
    await flush(20);
    expect(m.instance.lastFrame() ?? '').toMatch(/3\/3/);
    m.instance.stdin.write('n');
    await flush(20);
    expect(m.instance.lastFrame() ?? '').toMatch(/1\/3/);

    // N (shift) steps back one match (1/3 → 3/3, wrapping).
    m.instance.stdin.write('N');
    await flush(20);
    expect(m.instance.lastFrame() ?? '').toMatch(/3\/3/);
    m.instance.unmount();
  });

  it('Enter advances to the next match like n', async () => {
    const m = mount();
    await runSync(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    m.instance.stdin.write('a'); // 3 matches, active on the first (1/3)
    await flush(30);
    m.instance.stdin.write('\r'); // Enter → 2/3
    await flush(30);
    expect(m.instance.lastFrame() ?? '').toMatch(/2\/3/);
    m.instance.unmount();
  });

  it('an empty query (Ctrl+F with no typing) is a no-op that Esc still exits', async () => {
    const m = mount();
    await runSync(m);
    m.instance.stdin.write('\x06'); // Ctrl+F
    await flush(40);
    expect(m.instance.lastFrame() ?? '').toMatch(/no matches/);
    m.instance.stdin.write('\x1b'); // Esc
    await flush(40);
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command/);
    m.instance.unmount();
  });
});
