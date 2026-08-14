// v2 — the curated quick actions now render INSIDE the single palette (the
// former `h` home Mode merged into the palette's `commands` corpus). Renders the
// App, opens the palette via `h`, and asserts the curated sections render + a
// quick action dispatches through the shared seam + destructive ones confirm.

import { render } from 'ink-testing-library';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createProgram } from '../../src/bin.js';
import type { StatusPayload } from '../../src/commands/status.js';
import { App, type TuiDeps } from '../../src/tui/App.js';
import { buildPaletteCommands } from '../../src/tui/commands/registry.js';

const HEALTHY: StatusPayload = {
  noir: '1.9.0',
  project: { id: 'proj-test', name: 'noir-demo' },
  host: 'claude',
  daemon: { running: true, pid: 4242, uptimeSec: 125 },
  store: { docCount: 12, vecCount: 7, dbPath: '/tmp/x.db', degraded: false },
  context: null,
  workflow: null,
  memory: null,
};

const COMMANDS = buildPaletteCommands(createProgram());

function mount() {
  const dispatch = vi.fn(async (): Promise<void> => {});
  const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => HEALTHY);
  const deps: TuiDeps = { dispatch, fetchStatus, commands: COMMANDS };
  const instance = render(
    (<App deps={deps} initialPayload={HEALTHY} refreshMs={60000} />) as unknown as ReactElement,
  );
  return { instance, dispatch };
}

const flush = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('curated quick actions in the palette (v2)', () => {
  it('h on the dashboard opens the palette with the curated quick actions', async () => {
    const { instance } = mount();
    instance.stdin.write('h');
    await flush();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/palette/i);
    expect(frame).toMatch(/Status & context/i); // a curated section header
    expect(frame).toMatch(/Status/); // the first quick action
    instance.unmount();
  });

  it('Esc in the palette returns to the dashboard', async () => {
    const { instance } = mount();
    instance.stdin.write('h');
    await flush();
    instance.stdin.write('\x1b'); // Esc
    await flush();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/type a \/command/i); // dashboard input hint
    instance.unmount();
  });

  it('Enter on the top quick action dispatches through deps.dispatch', async () => {
    const { instance, dispatch } = mount();
    instance.stdin.write('h');
    await flush();
    instance.stdin.write('\r'); // Enter on the first action (Status)
    await flush(120);
    expect(dispatch).toHaveBeenCalled();
    expect(dispatch).toHaveBeenCalledWith(['status']);
    instance.unmount();
  });

  it('a destructive quick action routes through the confirm overlay', async () => {
    const { instance, dispatch } = mount();
    instance.stdin.write('h');
    await flush();
    // Navigate down to a destructive action ('Index project', row 2).
    instance.stdin.write('\x1b[B');
    await flush();
    instance.stdin.write('\r');
    await flush();
    // Not yet dispatched — the confirm overlay shows.
    expect(dispatch).not.toHaveBeenCalled();
    expect(instance.lastFrame() ?? '').toMatch(/y\/N/i);
    instance.unmount();
  });
});

describe('palette-first initial mode (noir palette)', () => {
  it('renders the palette when initialMode is palette', async () => {
    const dispatch = vi.fn(async (): Promise<void> => {});
    const fetchStatus = vi.fn(async (): Promise<StatusPayload | null> => HEALTHY);
    const deps: TuiDeps = { dispatch, fetchStatus, commands: COMMANDS };
    const instance = render(
      (
        <App
          deps={deps}
          initialPayload={HEALTHY}
          refreshMs={60000}
          initialMode={{ kind: 'palette', corpus: 'commands' }}
        />
      ) as unknown as ReactElement,
    );
    await flush();
    const frame = instance.lastFrame() ?? '';
    expect(frame).toMatch(/palette/i);
    expect(frame).toContain('Status'); // the command list is rendered
    instance.unmount();
  });
});
