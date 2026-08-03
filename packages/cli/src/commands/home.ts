// S9 t4 — `noir` (bare) home menu.
//
// The interactive entry point. Dispatch rules (spec F1 / AC1 / task t4):
//   • interactive (TTY && !CI && !NO_COLOR && !--json && !--no-input) → the
//     @clack/prompts select menu (intro + quick actions), dispatching the
//     chosen action through the SAME commander program the bin uses, so the
//     menu automatically inherits those implementations as they land.
//   • non-interactive + --json → run `status --json` (machine snapshot).
//   • non-interactive + no --json → run `status` (human snapshot). Safe now that
//     `status` is probe-only: it NEVER auto-starts a daemon and exits 0
//     even when the daemon is down, so bare `noir` in CI / a pipe is a useful
//     no-op snapshot instead of a noisy failure or a help dump.
//
// `@clack/prompts` is imported lazily inside the interactive branch so the
// non-interactive paths (the common CI/script case) never pay for it and never
// touch stdin/stdout rendering (NF6). The menu never blocks when input is
// disabled — `isInteractive` already gated that — and a Ctrl+C at any prompt
// maps to exit 5 (CANCELLED) via `fail`.
//
// Decoupling: `home` takes its `dispatch` as an injected callback (provided by
// bin.ts) so this module has NO import edge back to bin.ts (which would be
// circular: bin imports home). That also makes the menu unit-testable without
// commander — tests pass a fake callback + mock @clack.

import { type HostId, hostLaunchDirective } from '@noir-ai/adapters';
import {
  type InstallRecord,
  loadProjectInfo,
  NOIR_VERSION,
  readInstallRecord,
} from '@noir-ai/core';
import { NOIR_TAGLINE, renderBanner, shouldShowBanner } from '../banner.js';
import { type CliOptions, EXIT, fail, isInteractive } from '../output.js';
import { c } from '../theme.js';
import { DEFAULT_UPDATE_CONFIG, runAsyncUpdateCheck } from './update.js';

/** Callbacks home needs from the bin (injected → no circular import). */
export interface HomeDeps {
  /**
   * Run a sub-command by user-form argv (e.g. `['status','--json']`) on a fresh
   * commander program. Must NOT throw — it owns its own error → exit-code
   * mapping (bin's `handleError`) and leaves the outcome on `process.exitCode`
   * so it becomes the final exit code of the whole `noir` invocation.
   */
  dispatch: (argv: readonly string[]) => Promise<void>;
}

/** Try to read the project for a friendlier intro banner; never throws. */
function tryProject(): { id: string; name: string; host: HostId } | null {
  try {
    const info = loadProjectInfo(process.cwd());
    return { id: info.id, name: info.name, host: info.config.host };
  } catch {
    // Not initialized yet (no `.noir/project-id`) — the menu still works; it
    // just shows the generic intro. `Status` will surface the real error.
    return null;
  }
}

/**
 * One-time nudge: shows only for non-native installs, once per version. The
 * "dismissed for this version" flag is stored in install.json's record
 * (`dismissedVersions` is added on demand); absence ⇒ show.
 */
export function shouldShowMigrationBanner(rec: InstallRecord, _currentVersion: string): boolean {
  if (rec.method === 'native') return false;
  return true; // naive v1: show whenever non-native; dismissal persists via a flag added in Task 11 hardening
}

/** One-line summary of the CLI command surface (shown under the banner). */
const COMMANDS_HINT =
  'Commands: init · create · sync · status · context · memory · skills · task · daemon · doctor';

// The host-direction line is the shared `hostLaunchDirective` in
// `@noir-ai/adapters` (single source): the home banner AND the handoff artifact
// both call it, so the wording never drifts. The local `hostDirection` wrapper
// is gone; `hostLaunchDirective(host)` is called directly at the render sites.

/**
 * Bare-`noir` router. See module header for the three dispatch arms. Never
 * blocks when input is disabled (the interactive branch is unreachable then).
 *
 * TUI policy: `--no-tui` (`opts.tui === false`) forces the non-interactive
 * `status` path even when {@link isInteractive} would be true (a TTY). `--tui`
 * (`opts.tui === true`) is advisory only — it still requires a TTY, so the
 * `isInteractive(opts)` gate already encodes that. Auto (no flag) preserves the
 * prior behavior. Advisory only — `home` never hard-gates any subcommand.
 */
export async function home(opts: CliOptions, deps: HomeDeps): Promise<void> {
  if (isInteractive(opts) && opts.tui !== false) {
    await runMenu(opts, deps);
    return;
  }
  if (opts.json === true) {
    // Machine snapshot — same data `noir status --json` produces.
    await deps.dispatch(['status', '--json']);
    return;
  }
  // Non-interactive, human: run `status` (human snapshot). status is probe-only
  // — it never auto-starts a daemon and exits 0 even when down, so this is
  // a useful bare-`noir` snapshot in CI / pipes instead of a help dump.
  await deps.dispatch(['status']);
}

/** The @clack select menu (interactive arm). */
async function runMenu(opts: CliOptions, deps: HomeDeps): Promise<void> {
  // Lazy import: the non-interactive paths never load @clack (NF6).
  const clack = await import('@clack/prompts');

  const project = tryProject();

  // fire-and-forget; never blocks, never prints under --json/--quiet/CI/non-TTY.
  void runAsyncUpdateCheck({
    env: process.env,
    configUpdate: (() => {
      // Try to read the project's update config block; fall back to defaults
      // if the project isn't initialized or the block is absent.
      try {
        const info = loadProjectInfo(process.cwd());
        return info.config.update ?? DEFAULT_UPDATE_CONFIG;
      } catch {
        return DEFAULT_UPDATE_CONFIG;
      }
    })(),
    quiet: opts.json === true || opts.quiet === true || !process.stdout.isTTY,
  });

  if (shouldShowBanner(opts)) {
    const host = project?.host ?? 'claude';
    process.stderr.write(
      `\n${renderBanner()}\n${NOIR_TAGLINE}\n\n${hostLaunchDirective(host)}\n${COMMANDS_HINT}\n\n`,
    );
  }

  // One-time migration nudge for non-native installs.
  const rec = readInstallRecord();
  if (rec && shouldShowMigrationBanner(rec, NOIR_VERSION)) {
    process.stderr.write(
      `\n  ${c.warn(`noir installed via ${rec.method}`)} — consider \`noir install\` for the native path (auto-update, no npm prefix/PATH issues). Dismiss with: \`noir install --list\` (persisted per version).\n\n`,
    );
  }

  clack.intro(project ? `noir — ${project.name}` : 'noir');

  const choice = await clack.select({
    message: 'What would you like to do?',
    initialValue: 'status',
    options: [
      { value: 'status', label: 'Status', hint: 'project + daemon + store snapshot' },
      { value: 'index', label: 'Index project', hint: '(re)index files into context' },
      { value: 'recall', label: 'Recall memory', hint: 'search cross-session memory' },
      { value: 'next', label: 'Next task', hint: 'suggest next phase + skill' },
      { value: 'handoff', label: 'Handoff', hint: 'ready-to-paste host prompt' },
      { value: 'daemon', label: 'Start daemon', hint: 'foreground daemon' },
      { value: 'sync', label: 'Sync skills', hint: 're-emit builtin skills' },
      { value: 'exit', label: 'Exit' },
    ],
  });

  if (clack.isCancel(choice)) {
    clack.cancel('Cancelled.');
    // exit 5 (CANCELLED). Plain-text fail: the interactive branch implies
    // !--json, so the {ok,error} envelope does not apply here.
    fail(EXIT.CANCELLED, 'cancelled', opts);
  }

  const argv = await argvForChoice(choice as string, clack, opts);
  if (argv === null) {
    // "Exit" — nothing to dispatch.
    clack.outro('bye');
    return;
  }
  await deps.dispatch(argv);
  clack.outro('done');
}

/**
 * Map a menu choice to the sub-command argv, prompting for any required
 * argument the menu can't supply inline. Returns `null` for "Exit" (no
 * dispatch). A cancel at a sub-prompt → exit 5.
 */
async function argvForChoice(
  choice: string,
  clack: typeof import('@clack/prompts'),
  opts: CliOptions,
): Promise<string[] | null> {
  switch (choice) {
    case 'status':
      return ['status'];
    case 'index':
      return ['context', 'index'];
    case 'next':
      return ['task', 'next'];
    case 'handoff':
      // The ready-to-paste host prompt. Dispatched through the same commander
      // program as every other action, so it owns its own exit code.
      return ['handoff'];
    case 'daemon':
      return ['daemon', 'start'];
    case 'sync':
      return ['sync'];
    case 'exit':
      return null;
    case 'recall': {
      // memory recall needs a query — collect it inline so dispatch doesn't
      // immediately bounce with commander's "missing required argument".
      const query = await clack.text({
        message: 'Recall query:',
        placeholder: 'e.g. auth flow, ContextEngine, deploy steps',
      });
      if (clack.isCancel(query)) {
        clack.cancel('Cancelled.');
        fail(EXIT.CANCELLED, 'cancelled', opts);
      }
      return ['memory', 'recall', String(query)];
    }
    default:
      // select constrains values to the listed options; defensive default.
      return null;
  }
}
