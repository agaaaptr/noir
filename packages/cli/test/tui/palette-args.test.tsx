// Inline argument collection in the command palette, driven end-to-end through
// the App with ink-testing-library and a stubbed dispatch seam.
//
// A palette row whose command cannot run bare (it declares a required argument,
// or a curated quick action declares one for it) must not dispatch its argv as
// it stands: selecting it collects the value on the input line first, Esc backs
// out to the filter, and a destructive command still passes through the confirm
// gate with the collected value appended.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StatusPayload } from '../../src/commands/status.js';
import { App, type TuiDeps } from '../../src/tui/App.js';
import { __setNoirHome } from '../../src/tui/palette/history.js';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

const CTRL_K = '';
const ESC = '';
const ENTER = '\r';

const HEALTHY: StatusPayload = {
  noir: '1.15.0',
  project: { id: 'proj-args', name: 'noir-demo' },
  host: 'claude',
  daemon: { running: true, pid: 4242, uptimeSec: 125 },
  store: { docCount: 12, vecCount: 7, dbPath: '/tmp/x.db', degraded: false },
  context: null,
  workflow: null,
  memory: null,
};

/** `run` needs a prompt (destructive), `context search` needs a query (a read). */
const RUN: PaletteCommand = {
  id: 'run',
  label: 'Run',
  argv: ['run'],
  category: 'run',
  keywords: ['run'],
  description: 'ask the host agent a question',
  destructive: true,
  needsArg: 'prompt',
};

const SEARCH: PaletteCommand = {
  id: 'context search',
  label: 'Context: Search',
  argv: ['context', 'search'],
  category: 'context',
  keywords: ['context', 'search'],
  description: 'hybrid search over the indexed context',
  destructive: false,
  needsArg: 'query',
};

const STATUS: PaletteCommand = {
  id: 'status',
  label: 'Status',
  argv: ['status'],
  category: 'status',
  keywords: ['status'],
  description: 'project + daemon + store snapshot',
  destructive: false,
};

interface Mounted {
  readonly instance: ReturnType<typeof render>;
  readonly dispatch: ReturnType<typeof vi.fn>;
}

let savedNoColor: string | undefined;
let savedClicolor: string | undefined;
let home: string;

beforeEach(() => {
  savedNoColor = process.env.NO_COLOR;
  savedClicolor = process.env.CLICOLOR_FORCE;
  delete process.env.NO_COLOR;
  delete process.env.CLICOLOR_FORCE;
  home = mkdtempSync(join(tmpdir(), 'noir-tui-palette-args-'));
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

/** Render the App with a stubbed dispatch + isolated command history. */
function mount(commands: readonly PaletteCommand[] = [RUN, SEARCH, STATUS]): Mounted {
  const dispatch = vi.fn(async (): Promise<void> => {});
  const deps: TuiDeps = {
    dispatch,
    fetchStatus: async () => HEALTHY,
    commands,
    matcher: handRolledMatcher,
    record: async () => {},
    loadRecent: async () => [],
  };
  const element = (
    <App deps={deps} initialPayload={HEALTHY} refreshMs={60000} />
  ) as unknown as ReactElement;
  return { instance: render(element), dispatch };
}

/** Resolve after a short macrotask so React's async state flushes land. */
function flush(ms = 60): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open the palette and filter down to `query`. */
async function openAndFilter(m: Mounted, query: string): Promise<void> {
  m.instance.stdin.write(CTRL_K);
  await flush(80);
  m.instance.stdin.write(query);
  await flush(60);
}

describe('palette argument collection', () => {
  it('collects the prompt for `run`, confirms, then dispatches it', async () => {
    const m = mount();
    await openAndFilter(m, 'run');

    // Enter starts collecting instead of dispatching the bare argv.
    m.instance.stdin.write(ENTER);
    await flush(60);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.instance.lastFrame() ?? '').toContain('prompt for run');

    m.instance.stdin.write('fix the bug');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(80);

    // `run` is destructive — the collected argv waits at the confirm gate.
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.instance.lastFrame() ?? '').toMatch(/y\/N/i);

    m.instance.stdin.write('y');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(['run', 'fix the bug']);
    m.instance.unmount();
  });

  it('collects the query for `context search` and dispatches without a confirm', async () => {
    const m = mount();
    await openAndFilter(m, 'search');

    m.instance.stdin.write(ENTER);
    await flush(60);
    expect(m.instance.lastFrame() ?? '').toContain('query for context search');

    m.instance.stdin.write('auth flow');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(120);

    expect(m.dispatch).toHaveBeenCalledTimes(1);
    expect(m.dispatch).toHaveBeenCalledWith(['context', 'search', 'auth flow']);
    // Back on the dashboard (a read never opens the confirm overlay).
    expect(m.instance.lastFrame() ?? '').toMatch(/\/command/);
    m.instance.unmount();
  });

  it('cancels on Esc: back to the filter, nothing dispatched, filter still live', async () => {
    const m = mount();
    await openAndFilter(m, 'run');

    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('discard me');
    await flush(60);

    m.instance.stdin.write(ESC);
    await flush(60);
    expect(m.dispatch).not.toHaveBeenCalled();
    const frame = m.instance.lastFrame() ?? '';
    // The typed argument and the argument prompt are both gone; the filter (its
    // query still `run`) and its rows are back in charge.
    expect(frame).not.toContain('discard me');
    expect(frame).not.toContain('prompt for run');
    expect(frame).toContain('Run');
    // …and collecting can be entered again from the restored filter.
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('kept');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('y');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledWith(['run', 'kept']);
    m.instance.unmount();
  });

  it('collects for the curated "Ask the host" quick action (empty query)', async () => {
    const m = mount([RUN]);
    m.instance.stdin.write(CTRL_K);
    await flush(100);
    expect(m.instance.lastFrame() ?? '').toContain('Ask the host');

    m.instance.stdin.write(ENTER);
    await flush(60);
    expect(m.instance.lastFrame() ?? '').toContain('prompt for run');
    m.instance.stdin.write('summarise');
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write('y');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledWith(['run', 'summarise']);
    m.instance.unmount();
  });

  it('ignores Enter while the argument is empty', async () => {
    const m = mount();
    await openAndFilter(m, 'search');
    m.instance.stdin.write(ENTER);
    await flush(60);
    m.instance.stdin.write(ENTER);
    await flush(80);
    expect(m.dispatch).not.toHaveBeenCalled();
    m.instance.unmount();
  });
});

describe('typed /command path', () => {
  it('dispatches /run <prompt> exactly as before (confirm, then dispatch)', async () => {
    const m = mount();
    m.instance.stdin.write('/run ');
    await flush(40);
    m.instance.stdin.write('fix the bug');
    await flush(40);
    m.instance.stdin.write(ENTER);
    await flush(80);
    expect(m.dispatch).not.toHaveBeenCalled();
    expect(m.instance.lastFrame() ?? '').toMatch(/y\/N/i);

    m.instance.stdin.write('y');
    await flush(120);
    expect(m.dispatch).toHaveBeenCalledWith(['run', 'fix', 'the', 'bug']);
    m.instance.unmount();
  });
});
