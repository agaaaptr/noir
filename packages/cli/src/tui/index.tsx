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

import { loadProjectInfo } from '@noir-ai/core';
import { render } from 'ink';
import { buildPaletteCommandsForTui } from '../bin.js';
import { gatherStatusPayload, type StatusOptions, type StatusPayload } from '../commands/status.js';
import type { CliOptions } from '../output.js';
import { App, type TuiDeps } from './App.js';
import { loadRecent, recordRecent } from './palette/history.js';

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
  const deps = await buildTuiDeps(opts, dispatch);
  const instance = render(<App deps={deps} />);
  await instance.waitUntilExit();
}

/**
 * `noir palette` — mount the App palette-first (S3). Reuses the SAME
 * `runTui` deps (dispatch seam, commands, recents) so the fuzzy command
 * palette is identical to the dashboard's Ctrl+K palette, just opened
 * directly. `dispatch` is the same shape `runTui` receives from bin.ts.
 */
export async function runPalette(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<void> {
  // Reuse runTui's deps wiring wholesale, then render palette-first.
  // Factor the shared deps build out of runTui into a helper to avoid
  // duplicating the projectId/commands/recents logic.
  const deps = await buildTuiDeps(opts, dispatch);
  const instance = render(<App deps={deps} initialMode={{ kind: 'palette' }} />);
  await instance.waitUntilExit();
}

/**
 * Build the shared {@link TuiDeps} for both `runTui` and `runPalette`.
 * Extracted so the two entry points cannot drift (projectId-keyed recents,
 * the palette source, and the dispatch seam are identical).
 */
async function buildTuiDeps(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<TuiDeps> {
  // ProjectId-keyed recent-commands persistence (C3): resolve the canonical id
  // once at launch so recents are isolated per project (respects the .noir/
  // single-source-of-truth invariant). An uninitialized project (loadProjectInfo
  // throws) degrades to empty recents — the palette still works with the full
  // command list.
  let projectId: string | null = null;
  try {
    projectId = loadProjectInfo(process.cwd()).id;
  } catch {
    projectId = null;
  }
  const deps: TuiDeps = {
    dispatch,
    fetchStatus: defaultFetchStatus(opts),
    // The palette source, derived from a fresh commander program at launch (B3).
    commands: buildPaletteCommandsForTui(),
    // C3 — persistent recent commands (projectId-keyed). recordRecent is async
    // only to match the TuiDeps seam; it never rejects.
    record: (argv) => {
      if (projectId) recordRecent(projectId, argv);
      return Promise.resolve();
    },
    loadRecent: async () => {
      if (!projectId) return [];
      // Hydrate the bare {argv,id} entries against the live palette commands so
      // the palette renders real labels/descriptions; drop stale entries whose
      // argv no longer exists in the current build.
      const byId = new Map(deps.commands?.map((c) => [c.id, c]) ?? []);
      return loadRecent(projectId)
        .map((e) => byId.get(e.id))
        .filter((c): c is NonNullable<typeof c> => c !== undefined);
    },
  };
  return deps;
}
