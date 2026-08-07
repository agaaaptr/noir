// S9 t4 + home-consolidation — `noir` (bare) home menu.
//
// The interactive entry point. Dispatch rules (spec F1 / AC1 / task t4):
//   • interactive (TTY && !CI && !NO_COLOR && !--json && !--no-input) → the
//     @clack/prompts grouped home menu (intro + sections + quick actions),
//     dispatching the chosen action through the SAME commander program the bin
//     uses, so the menu automatically inherits those implementations as they
//     land.
//   • non-interactive + --json → run `status --json` (machine snapshot).
//   • non-interactive + no --json → run `status` (human snapshot). Safe now that
//     `status` is probe-only: it NEVER auto-starts a daemon and exits 0
//     even when the daemon is down, so bare `noir` in CI / a pipe is a useful
//     no-op snapshot instead of a noisy failure or a help dump.
//
// Home-consolidation (S2): the interactive arm is a two-level grouped menu —
// a section picker (select, arrow-navigable) then per-section action lists
// (select with per-option hints). Navigation is smooth: Esc / backspace /
// ← return to the section picker, → jumps to the next section, ← to the
// previous, so the user can move across sections without re-entering level 1
// each time. The section content comes from the SHARED React-free
// {@link resolveSections} module (tui/commands/sections.ts), which references
// palette-registry ids — so the menu cannot drift from the commander tree.
// `deps.commands` is injected by bin.ts (the same list the TUI palette uses).
//
// Both levels use `clack.select` (NOT `selectKey`): `selectKey` is a
// select-by-typed-letter prompt with no arrow/enter/esc handling, and its
// `_track=false` value stays `undefined` until a letter is pressed — Enter
// crashes with `Cannot read properties of undefined (reading 'label')` (the
// 1.9.0 home-menu bug, fixed by `select` on @clack ≥1.7).
//
// `@clack/prompts` is imported lazily inside the interactive branch so the
// non-interactive paths (the common CI/script case) never pay for it and never
// touch stdin/stdout rendering (NF6). The menu never blocks when input is
// disabled — `isInteractive` already gated that — and a Ctrl+C at any prompt
// maps to exit 5 (CANCELLED) via `fail`.
//
// Decoupling: `home` takes its `dispatch` + `commands` as injected callbacks
// (provided by bin.ts) so this module has NO import edge back to bin.ts (which
// would be circular: bin imports home). That also makes the menu unit-testable
// without commander — tests pass a fake callback + mock @clack.

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
import { isDestructive } from '../tui/commands/registry.js';
import { type HomeAction, type HomeSection, resolveSections } from '../tui/commands/sections.js';
import type { PaletteCommand } from '../tui/palette/types.js';
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
  /**
   * The live palette commands (derived from `createProgram()` by bin.ts) — the
   * same source the TUI palette uses. The grouped home menu resolves its
   * sections against this so it cannot drift. Optional for backward-compat
   * (older tests omit it); when absent, sections fall back to the internal
   * curated ids that resolve against a fresh registry.
   */
  readonly commands?: readonly PaletteCommand[];
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
 * (`dismissedVersions`); absence ⇒ show. Once the user dismisses (via
 * `noir install --dismiss`), the current CLI version is appended and the
 * banner stays silent until they next upgrade Noir.
 */
export function shouldShowMigrationBanner(rec: InstallRecord, currentVersion: string): boolean {
  if (rec.method === 'native') return false;
  if (rec.dismissedVersions?.includes(currentVersion)) return false;
  return true;
}

/** One-line summary of the CLI command surface (shown under the banner). */
const COMMANDS_HINT =
  'Commands: status · context · memory · task · skills · daemon · doctor · install · update · tui · palette';

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

// ---------------------------------------------------------------------------
// The grouped home menu (interactive arm).
//
// Two levels driven by a small state machine so navigation is smooth:
//   LEVEL 1 — section picker (clack.select): 1-6 sections + Exit.
//   LEVEL 2 — per-section action list (clack.select with hints).
//
// Navigation keys are handled by @clack itself at each level (Esc cancels that
// prompt). We return a sentinel from each level and branch on it, so "back"
// from level 2 loops back to level 1, and "next"/"previous" from level 2 jump
// to the adjacent section's action list. Cancel anywhere → exit 5 (CANCELLED).
// ---------------------------------------------------------------------------

/** @clack's `select` result is a value | cancel-symbol. */
type ClackChoice = string | symbol;

/** The @clack/prompts module (lazy). */
type Clack = typeof import('@clack/prompts');

/**
 * Level 1 — the section picker. Returns which section to open, or a control
 * outcome. Uses `select` (NOT `selectKey`) so arrow navigation, Enter-to-submit,
 * and Esc/Ctrl+C cancel all work. `selectKey` is a select-by-typed-letter prompt
 * with no arrow/enter/esc handling and a `_track=false` value that stays
 * `undefined` until a matching letter is pressed — pressing Enter there crashes
 * with `Cannot read properties of undefined (reading 'label')` (the 1.9.0 home
 * menu bug, fixed by switching to `select` on @clack ≥1.7).
 */
async function pickSection(
  clack: Clack,
  sections: readonly HomeSection[],
  opts: CliOptions,
): Promise<ClackChoice> {
  const result = await clack.select({
    message: 'What would you like to do?',
    options: [
      ...sections.map((s) => ({
        value: s.id,
        label: s.label,
        hint: s.hint,
      })),
      { value: 'exit', label: 'Exit', hint: 'leave the home menu' },
    ],
  });
  if (clack.isCancel(result)) {
    clack.cancel('Cancelled.');
    fail(EXIT.CANCELLED, 'cancelled', opts);
  }
  return result;
}

/**
 * Level 2 — the action list for `section`. Returns which action to run, or a
 * control outcome. `select` renders each action with a one-line `hint`; the
 * final "Back" option returns to the section picker. Cancel → back too.
 */
async function pickAction(
  clack: Clack,
  section: HomeSection,
  sections: readonly HomeSection[],
  opts: CliOptions,
): Promise<ClackChoice> {
  const idx = sections.findIndex((s) => s.id === section.id);
  const hasPrev = idx > 0;
  const hasNext = idx !== -1 && idx < sections.length - 1;
  const result = await clack.select({
    message: section.label,
    initialValue: section.items[0]?.id,
    options: [
      ...section.items.map((a) => ({
        value: a.id,
        label: a.label,
        hint: a.hint,
      })),
      // Navigation options so the user can move across sections without
      // re-entering the section picker (the "lancar" navigation requirement).
      ...(hasPrev
        ? [{ value: 'prev' as const, label: '← Prev section', hint: sections[idx - 1]?.label }]
        : []),
      ...(hasNext
        ? [{ value: 'next' as const, label: '→ Next section', hint: sections[idx + 1]?.label }]
        : []),
      { value: 'back', label: '↑ Back to sections', hint: 'return to the section picker' },
    ],
  });
  if (clack.isCancel(result)) {
    // Esc / Ctrl+C at the action list → back to the section picker (not exit).
    clack.cancel('Back to the home menu.');
    return 'back';
  }
  if (opts.verbose) {
    process.stderr.write(`noir: home: section '${section.id}' selected\n`);
  }
  return result;
}

/**
 * Collect an inline argument for an action that needs one (generalizes the
 * existing recall-query pattern). Cancel → exit 5.
 */
async function collectArg(
  clack: Clack,
  action: HomeAction,
  opts: CliOptions,
): Promise<string | null> {
  if (!action.needsArg) return null;
  const value = await clack.text({
    message: action.needsArg.prompt,
    placeholder: action.needsArg.placeholder,
    validate: (v: string | undefined) =>
      !v || v.trim().length === 0 ? 'Please enter a value.' : undefined,
  });
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled.');
    fail(EXIT.CANCELLED, 'cancelled', opts);
  }
  return String(value);
}

/**
 * Resolve the argv an action dispatches: the registry-derived `dispatch`,
 * plus the collected inline arg (when the action needs one). A `destructive`
 * action gates behind a clack.confirm first (reusing the palette registry's
 * destructive table). Returns null when the user declined a destructive action.
 */
async function argvForAction(
  clack: Clack,
  action: HomeAction,
  opts: CliOptions,
): Promise<string[] | null> {
  const base = action.dispatch ?? [action.id];
  let argv = [...base];
  // Collect an inline arg ONLY when the action needs one; a non-arg action
  // skips the prompt entirely (this is what distinguishes "no arg needed"
  // from "cancelled" — both used to collide on `null` and infinite-loop).
  if (action.needsArg) {
    const arg = await collectArg(clack, action, opts);
    if (arg === null) return null; // cancelled → back to the section
    argv = [...base, arg];
  }

  // Gate destructive actions behind an explicit confirm (matches the TUI
  // palette's destructive-confirm overlay — same table, isDestructive()).
  if (action.destructive || isDestructive(argv)) {
    const confirmed = await clack.confirm({
      message: `Run \`noir ${argv.join(' ')}\`? This may modify project files / the store.`,
      initialValue: false,
    });
    if (clack.isCancel(confirmed) || !confirmed) return null;
  }
  return argv;
}

/**
 * The grouped home menu loop. Drives the two levels and the back/next/previous
 * navigation. Dispatch through the shared seam; a selected action returns so
 * `runMenu` can print the outro.
 */
async function runGroupedMenu(
  clack: Clack,
  opts: CliOptions,
  deps: HomeDeps,
  sections: readonly HomeSection[],
): Promise<void> {
  // Start on the first section's action list if the user just wants to move
  // fast; otherwise start at the section picker. We begin at the picker so
  // first-run users see the grouping.
  let currentSection: number | null = null; // null = level 1 (section picker)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    // LEVEL 1 — section picker
    if (currentSection === null) {
      const picked = await pickSection(clack, sections, opts);
      if (clack.isCancel(picked) || picked === 'exit') {
        clack.outro('bye');
        return;
      }
      const idx = sections.findIndex((s) => s.id === picked);
      if (idx === -1) {
        // Unknown section value — defensive: re-show the picker.
        continue;
      }
      currentSection = idx;
      continue;
    }

    // LEVEL 2 — the current section's action list
    const section = sections[currentSection];
    if (!section) {
      // Defensive: index out of range — back to the picker.
      currentSection = null;
      continue;
    }
    const chosen = await pickAction(clack, section, sections, opts);
    if (clack.isCancel(chosen)) {
      // Esc at the action list → back to the picker.
      currentSection = null;
      continue;
    }

    switch (chosen) {
      case 'back': {
        // ← Back → level 1.
        currentSection = null;
        continue;
      }
      case 'next': {
        // → Next section (progressive: no need to re-pick at level 1).
        currentSection = (currentSection + 1) % sections.length;
        continue;
      }
      case 'prev': {
        // ← Previous section.
        currentSection = (currentSection - 1 + sections.length) % sections.length;
        continue;
      }
      default: {
        const action = section.items.find((a) => a.id === chosen);
        if (!action) {
          // Defensive: unknown action id — back to the picker.
          currentSection = null;
          continue;
        }
        const argv = await argvForAction(clack, action, opts);
        if (argv === null) {
          // Destructive declined (or arg cancelled) → stay in the section.
          continue;
        }
        await deps.dispatch(argv);
        clack.outro('done');
        return; // one action per `noir` run, then the process exits
      }
    }
  }
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
      `\n  ${c.warn(`noir installed via ${rec.method}`)} — consider \`noir install\` for the native path (auto-update, no npm prefix/PATH issues). Dismiss with: \`noir install --dismiss\` (persisted per version).\n\n`,
    );
  }

  clack.intro(project ? `noir — ${project.name}` : 'noir');

  // Resolve the curated sections against the LIVE palette registry. bin.ts
  // injects `deps.commands` (the same list the TUI palette uses). Tests that
  // omit it (backward-compat) pass an empty list → sections degrade to those
  // whose ids exist (none) — the menu would be empty, but those tests don't
  // drive the interactive arm's content. bin.ts always injects the real list.
  const sections = await resolveSections(deps.commands ?? []);

  await runGroupedMenu(clack, opts, deps, sections);
}
