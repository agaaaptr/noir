// `noir tui` entry — mounts the Ink dashboard. LAZY-loaded: bin.ts does
// `await import('./tui/index.js')` inside the `tui` action only, so React +
// Ink never enter the main CLI startup path (`noir status`, `noir doctor`, a
// bare `noir` all stay React-free). The entry wires the default
// {@link TuiDeps.fetchStatus} (a wrapper around `gatherStatusPayload` that
// folds any failure to `null`) and the SAME dispatch seam `home(opts, deps)`
// uses, then renders the App and resolves on exit.
//
// Stream discipline: while the dashboard runs, Ink owns the terminal (raw-mode
// stdin + ANSI render to stdout). On `q` / Esc / Ctrl+C, Ink restores the
// terminal before unmounting. Dispatched commands write through the captured
// stream shim, so the host terminal only ever sees Ink's frames.

import { render } from 'ink';
import { buildPaletteCommandsForTui } from '../bin.js';
import { gatherStatusPayload, type StatusOptions, type StatusPayload } from '../commands/status.js';
import type { CliOptions } from '../output.js';
import { App, type TuiDeps } from './App.js';

export type { TuiDeps } from './App.js';

/**
 * Default status fetcher: wraps {@link gatherStatusPayload} so any failure (an
 * uninitialized project, a probe hiccup, a daemon-down that threw) folds to
 * `null` and the dashboard degrades cleanly. `gatherStatusPayload` itself is
 * probe-only and never auto-starts a daemon, so this is safe to poll.
 */
function defaultFetchStatus(opts: CliOptions): () => Promise<StatusPayload | null> {
  return async () => {
    try {
      return await gatherStatusPayload(opts as StatusOptions);
    } catch {
      return null;
    }
  };
}

/**
 * Mount the dashboard and resolve when the user exits. The caller (bin.ts)
 * supplies the dispatch seam — the same shape `home(opts, deps).dispatch`
 * uses — so command routing is owned by the bin, not reimplemented here.
 */
export async function runTui(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<void> {
  const deps: TuiDeps = {
    dispatch,
    fetchStatus: defaultFetchStatus(opts),
    // The palette source, derived from a fresh commander program at launch (B3).
    commands: buildPaletteCommandsForTui(),
  };
  const instance = render(<App deps={deps} />);
  await instance.waitUntilExit();
}
