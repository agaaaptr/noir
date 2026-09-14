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

import { type HostId, SUPPORTED_HOSTS } from '@noir-ai/adapters';
import { loadProjectInfo, parseConfig } from '@noir-ai/core';
import { render } from 'ink';
import { buildPaletteCommandsForTui } from '../bin.js';
import { mergeEnv } from '../commands/run.js';
import { gatherStatusPayload, type StatusOptions, type StatusPayload } from '../commands/status.js';
import { runHost } from '../orchestrator.js';
import type { CliOptions } from '../output.js';
import { type PostRunActionInput, performPostRunAction, postRunActions } from '../run-actions.js';
import { loadRunConfig, resolveRunProfile } from '../run-profiles.js';
import { App, type TuiDeps } from './App.js';
import type { RunActionRequest, RunDeps, RunSession, RunStartHandlers } from './modes/run.js';
import { loadRecent, recordRecent } from './palette/history.js';
import { createTranscriptStore } from './transcripts.js';

export type { TuiDeps } from './App.js';

/**
 * The host the dashboard drives. `noir tui` carries no host flag, so it drives
 * the same default `noir run` does; a `run.profiles` default (or `NOIR_PROFILE`)
 * can still point it at another binary.
 */
const DEFAULT_RUN_HOST: HostId = 'claude';

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
 * Resolve the profile, spawn the host, hand back the session handle. The
 * spawn is built here rather than in the run screen so that screen stays a
 * renderer: it is handed a `start` and only knows how to draw what comes back.
 *
 * Synchronous by design — the caller renders the pane it just asked for — so a
 * failure to even resolve a spawn (an unknown profile, an unusable host) is
 * thrown rather than exiting the process: the screen reports it in place
 * instead of the dashboard dying at the first keystroke. A continuation
 * appends `--resume <id>` after the profile's own args, so the profile's flags
 * stay in effect on the resumed turn too.
 */
function startHostRun(
  prompt: string,
  handlers: RunStartHandlers,
  resumeSessionId?: string,
): RunSession {
  const host = DEFAULT_RUN_HOST;
  if (!(SUPPORTED_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`unknown host '${host}' (supported: ${SUPPORTED_HOSTS.join(', ')})`);
  }
  const profile = resolveProfile();
  const extraArgs =
    resumeSessionId === undefined
      ? profile.args
      : [...(profile.args ?? []), '--resume', resumeSessionId];
  const env = profile.env === undefined ? undefined : mergeEnv(process.env, profile.env);
  const binary = profile.binary !== undefined && profile.binary.length > 0 ? profile.binary : host;
  return {
    binary,
    done: runHost({
      host,
      prompt,
      ...(profile.binary === undefined ? {} : { customBinary: profile.binary }),
      ...(extraArgs === undefined ? {} : { extraArgs }),
      ...(env === undefined ? {} : { env }),
      onLine: handlers.onLine,
      onEvent: handlers.onEvent,
      signal: handlers.signal,
    }),
  };
}

/**
 * The effective run profile. Config load is best-effort, exactly as it is for
 * `noir run`: outside an initialized project there are no profiles and the
 * built-in host behavior stands. A profile that cannot be used is reported as
 * a plain error, because the caller is a screen that shows it, not a CLI that
 * exits on it.
 */
function resolveProfile(): {
  readonly binary?: string;
  readonly env?: Record<string, string | undefined>;
  readonly args?: readonly string[];
} {
  const config = loadRunConfig(process.cwd()) ?? parseConfig({});
  const resolved = resolveRunProfile(undefined, config, process.env);
  if (!resolved.ok) throw new Error(resolved.message);
  return resolved.profile;
}

/**
 * The run seams the dashboard uses: the same spawn, the same post-run action
 * set, and the same transcript directory a shell invocation reaches. The action
 * set and its performer are the shared definitions the terminal prompt offers —
 * the overlay decides how a row is drawn, never what a choice does.
 */
function defaultRunDeps(opts: CliOptions): RunDeps {
  const toInput = (request: RunActionRequest): PostRunActionInput => ({
    answer: request.answer,
    transcript: request.transcript,
    host: request.host,
    opts,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.canContinue === undefined ? {} : { canContinue: request.canContinue }),
  });
  return {
    start: (prompt, handlers, resumeSessionId) => startHostRun(prompt, handlers, resumeSessionId),
    actions: (request) => postRunActions(toInput(request)),
    perform: (request, choice, value) => performPostRunAction(choice, toInput(request), value),
    // Named by host, exactly as the CLI names its own transcripts, so a run
    // started from the dashboard lands beside one started from a shell.
    transcripts: createTranscriptStore({ host: DEFAULT_RUN_HOST }),
  };
}

/**
 * Mount the dashboard and resolve when the user exits. The caller (bin.ts)
 * supplies the dispatch seam — the same shape `home(opts, deps).dispatch`
 * uses — so command routing is owned by the bin, not reimplemented here.
 */
export async function runTui(opts: CliOptions, dispatch: TuiDeps['dispatch']): Promise<void> {
  process.stdout.write('\x1b[2J\x1b[H');
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
  process.stdout.write('\x1b[2J\x1b[H');
  // Reuse runTui's deps wiring wholesale, then render palette-first.
  // Factor the shared deps build out of runTui into a helper to avoid
  // duplicating the projectId/commands/recents logic.
  const deps = await buildTuiDeps(opts, dispatch);
  const instance = render(
    <App deps={deps} initialMode={{ kind: 'palette', corpus: 'commands' }} />,
  );
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
    // The live host-run screen. Present here (not optional in practice) is what
    // routes a `run <prompt>` selection to the screen instead of dispatching it
    // through the captured-command path — see `enterRunOrDispatch` in App.tsx.
    run: defaultRunDeps(opts),
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
