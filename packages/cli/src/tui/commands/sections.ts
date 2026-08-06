// Home-consolidation (S1) — the shared, React-free curated-section module.
//
// The bare `noir` home menu (packages/cli/src/commands/home.ts) and the Ink TUI
// home Mode (App.tsx, { kind: 'home' }) both render a curated set of quick
// actions. This module is the SINGLE source of that curation so the two
// renderers cannot drift — the same one-table-two-renderers idea that keeps the
// TUI palette aligned with the commander tree.
//
// No-drift contract: every {@link HomeAction} references a palette-registry
// `id` (e.g. 'context search'), NOT a hand-written argv. {@link resolveSections}
// re-derives the live palette commands and drops any action whose id no longer
// exists — so a future commander change degrades the menu to what exists
// instead of crashing it.
//
// This module is deliberately React-free (no ink import) so `home.ts` (the lean
// @clack path) can consume it without pulling React/Ink into the main CLI graph
// (NF6 lazy-import constraint). Callers pass the live palette commands
// explicitly (bin.ts injects them via HomeDeps / TuiDeps), so this module has
// no import edge back to bin.ts (home.ts must stay circular-import-free).

import type { PaletteCommand } from '../palette/types.js';

/** A single curated quick action: friendly copy + a palette-registry id. */
export interface HomeAction {
  /** The palette-registry id this action runs (e.g. `context search`). */
  readonly id: string;
  /** Friendly title-cased label for the menu (may differ from the leaf). */
  readonly label: string;
  /** One-line dim hint shown under/near the label (exact subcommand + purpose). */
  readonly hint: string;
  /**
   * True when this action mutates the store / workflow / host artifacts (the
   * same prefix table the TUI palette uses). The menu gates it behind a confirm
   * before dispatch.
   */
  readonly destructive?: boolean;
  /**
   * When set, the action collects this argument inline (via clack.text in the
   * menu, or a small text prompt in the TUI home) before dispatch. Mirrors the
   * existing recall-query pattern in home.ts.
   */
  readonly needsArg?: {
    readonly prompt: string;
    readonly placeholder: string;
  };
  /**
   * The exact argv to dispatch. Defaults to the palette entry's `argv`; a
   * `needsArg` action appends the collected value. Always resolves through the
   * registry so it cannot drift.
   */
  readonly dispatch?: readonly string[];
}

/** A named group of quick actions shown as one home-menu section. */
export interface HomeSection {
  /** Stable id (used as a section header + the selectKey value). */
  readonly id: string;
  /** Section title, e.g. 'Status & context'. */
  readonly label: string;
  /** One-line dim hint for the section (its subcommands). */
  readonly hint: string;
  /** The selectKey single-letter/num binding for this section (1-9). */
  readonly key: string;
  /** Ordered quick actions in this section. */
  readonly items: readonly HomeAction[];
}

/**
 * The curated home sections, in display order. Each action's `id` must exist in
 * the palette registry (verified by {@link resolveSections}); the friendly copy
 * is authored here once and rendered by both surfaces.
 */
export const HOME_SECTIONS: readonly HomeSection[] = [
  {
    id: 'status',
    label: 'Status & context',
    hint: 'snapshot · index · search · doctor',
    key: '1',
    items: [
      {
        id: 'status',
        label: 'Status',
        hint: 'project + daemon + workflow + store snapshot (noir status)',
      },
      {
        id: 'context index',
        label: 'Index project',
        hint: '(re)index files into context · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'context search',
        label: 'Search context',
        hint: 'hybrid search over indexed files',
        needsArg: { prompt: 'Context search query:', placeholder: 'e.g. auth flow, deploy steps' },
      },
      {
        id: 'doctor',
        label: 'Doctor',
        hint: 'environment + project health checks',
      },
      {
        id: 'context status',
        label: 'Context status',
        hint: 'index freshness + counts',
      },
    ],
  },
  {
    id: 'memory',
    label: 'Memory',
    hint: 'recall · save · sessions · forget · consolidate',
    key: '2',
    items: [
      {
        id: 'memory recall',
        label: 'Recall memory',
        hint: 'search cross-session memory',
        needsArg: { prompt: 'Recall query:', placeholder: 'e.g. auth flow, deploy steps' },
      },
      {
        id: 'memory save',
        label: 'Save memory',
        hint: 'save an observation · ⚠ destructive',
        destructive: true,
        needsArg: { prompt: 'Memory content:', placeholder: 'what you want to remember' },
      },
      {
        id: 'memory sessions',
        label: 'Sessions',
        hint: 'list recent memory sessions',
      },
      {
        id: 'memory forget',
        label: 'Forget memory',
        hint: 'forget observations by id · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'memory consolidate',
        label: 'Consolidate',
        hint: 'fold observations into lessons · ⚠ destructive',
        destructive: true,
      },
    ],
  },
  {
    id: 'workflow',
    label: 'Workflow',
    hint: 'next · status · advance · handoff · wrap',
    key: '3',
    items: [
      {
        id: 'task next',
        label: 'Next task',
        hint: 'suggest next phase + applicable skill',
      },
      {
        id: 'task status',
        label: 'Task status',
        hint: 'active task status',
      },
      {
        id: 'task advance',
        label: 'Advance task',
        hint: 'advance to next phase · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'handoff',
        label: 'Handoff',
        hint: 'ready-to-paste host prompt',
      },
      {
        id: 'wrap',
        label: 'Wrap (end session)',
        hint: 'session-end handoff',
        dispatch: ['wrap', '--write'],
      },
    ],
  },
  {
    id: 'setup',
    label: 'Setup & maintenance',
    hint: 'init · create · sync · skills · install · update',
    key: '4',
    items: [
      {
        id: 'init',
        label: 'Init',
        hint: 'scaffold Noir in this project · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'create',
        label: 'Create',
        hint: 'bootstrap in a new/empty dir · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'sync',
        label: 'Sync',
        hint: 're-emit managed files + skills · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'skills list',
        label: 'Skills list',
        hint: 'list installed skills',
      },
      {
        id: 'skills sync',
        label: 'Sync skills',
        hint: 're-emit builtin skills · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'update',
        label: 'Update',
        hint: 'check for a new version · ⚠ destructive',
        destructive: true,
      },
      {
        id: 'install',
        label: 'Install / migrate',
        hint: 'native install / migrate · ⚠ destructive',
        destructive: true,
      },
    ],
  },
  {
    id: 'dashboard',
    label: 'Dashboard (full-screen)',
    hint: 'noir tui · noir palette · home',
    key: '5',
    items: [
      {
        id: 'tui',
        label: 'Dashboard (full-screen)',
        hint: 'live status · /command · Ctrl+K palette (noir tui)',
      },
      {
        id: 'palette',
        label: 'All commands (fuzzy palette)',
        hint: 'fuzzy search over every command (noir palette)',
      },
    ],
  },
];

/**
 * Resolve the curated sections against a LIVE palette command list. Drops any
 * action whose `id` does not exist (graceful degradation) and any section left
 * empty. `dispatch` defaults to the palette entry's argv.
 *
 * @param commands The live palette commands (from
 *   `buildPaletteCommands(createProgram())`). bin.ts supplies them to both
 *   home.ts and the TUI — this module stays free of a bin.ts import edge (and
 *   of the load-time cycle a dynamic `import('../../bin.js')` would create,
 *   since bin.ts imports home.ts which imports this module).
 */
export async function resolveSections(commands: readonly PaletteCommand[]): Promise<HomeSection[]> {
  const byId = new Map(commands.map((c) => [c.id, c]));
  const out: HomeSection[] = [];
  for (const section of HOME_SECTIONS) {
    const items: HomeAction[] = [];
    for (const action of section.items) {
      const entry = byId.get(action.id);
      if (!entry) continue; // id removed from the tree — degrade, don't crash
      items.push({
        ...action,
        // Resolve the dispatch argv from the registry (never hand-written).
        dispatch: action.dispatch ?? [...entry.argv],
      });
    }
    if (items.length === 0) continue; // section went empty — drop it
    out.push({ ...section, items });
  }
  return out;
}
