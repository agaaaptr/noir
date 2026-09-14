// Pure row-building for the single command surface (v2). The App owns the
// query + active row + key routing; this module derives the visible rows for a
// corpus so the App can resolve the active row into a dispatch (Enter) while
// the presentational `Palette` renders the same rows — one source of truth for
// what the palette shows and what a selection runs.

import type { HomeAction, HomeSection } from '../commands/sections.js';
import { HELP_ENTRIES } from '../hints.js';
import type { FuzzyMatcher } from './matcher.js';
import { computeMatches } from './output.js';
import type { PaletteCommand } from './types.js';

/** The palette's active corpus. */
export type Corpus = 'commands' | 'output' | 'help';

/** All corpora, in `Tab`-cycle order. */
export const CORPORA: readonly Corpus[] = ['commands', 'output', 'help'];

const MATCH_LIMIT = 20;

/** How many rows the palette renders at once (the sliding window size). */
export const VISIBLE_ROWS = 10;

/** A rendered palette row. `argv` is null for non-dispatchable rows. */
export interface PaletteRow {
  key: string;
  primary: string;
  secondary: string;
  argv: readonly string[] | null;
  destructive: boolean;
  group: string | null;
  /**
   * The command's required value ('query', 'name', 'prompt') — the palette
   * collects it inline before dispatching, so `argv` alone would run the
   * command without its argument. Undefined for rows that dispatch bare (and
   * for non-dispatchable rows).
   */
  needsArg?: string;
}

/** Inputs to {@link buildPaletteRows}. */
export interface BuildRowsInput {
  corpus: Corpus;
  query: string;
  commands: readonly PaletteCommand[];
  matcher: FuzzyMatcher;
  recent: readonly PaletteCommand[];
  homeSections: readonly HomeSection[];
  outputLines: readonly string[];
}

/** Flatten curated home sections into `{ group, action }` rows. */
function flattenHome(sections: readonly HomeSection[]): { group: string; action: HomeAction }[] {
  const out: { group: string; action: HomeAction }[] = [];
  for (const section of sections) {
    for (const action of section.items) out.push({ group: section.label, action });
  }
  return out;
}

/** `recent` entries that still exist in `commands`, in recent order. */
function recentDeduped(
  recent: readonly PaletteCommand[],
  commands: readonly PaletteCommand[],
): PaletteCommand[] {
  const known = new Set(commands.map((cmd) => cmd.id));
  return recent.filter((cmd) => known.has(cmd.id));
}

/**
 * Argument requirements keyed by the argv a row dispatches. The CLI definition
 * supplies one for every command with a required positional; a curated quick
 * action may declare its own for a value the definition leaves optional or
 * passes as a flag. Keying by argv rather than by command id matters for the
 * flag case: a curated action that carries its value behind a flag (its argv
 * includes the flag) is the only row that can accept the value, so rows that
 * dispatch the command without the flag must not ask for one they would drop.
 */
function argRequirements(
  commands: readonly PaletteCommand[],
  homeSections: readonly HomeSection[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const cmd of commands) {
    if (cmd.needsArg !== undefined) out.set(cmd.argv.join(' '), cmd.needsArg);
  }
  for (const { action } of flattenHome(homeSections)) {
    const label = action.needsArg?.label;
    if (label !== undefined) out.set((action.dispatch ?? [action.id]).join(' '), label);
  }
  return out;
}

/**
 * The requirement for one row, looked up by the argv it would dispatch. The
 * command id is a fallback for a row whose argv the palette overrides without
 * declaring how the value is passed.
 */
function requirementFor(
  requirements: Map<string, string>,
  argv: readonly string[],
  id: string,
): string | undefined {
  return requirements.get(argv.join(' ')) ?? requirements.get(id);
}

/** Build the visible rows for the active corpus + query. */
export function buildPaletteRows(input: BuildRowsInput): PaletteRow[] {
  const { corpus, query, commands, matcher, recent, homeSections, outputLines } = input;

  if (corpus === 'help') {
    return HELP_ENTRIES.map((e) => ({
      key: `help:${e.keys}`,
      primary: e.keys,
      secondary: e.desc,
      argv: null,
      destructive: false,
      group: 'keybindings',
    }));
  }

  if (corpus === 'output') {
    const matches = computeMatches(outputLines, query);
    if (query.length > 0 && matches.length === 0) {
      // A typed filter with zero hits is an explicit empty state — never list
      // the full output under a misleading "matches" header.
      return [
        {
          key: 'empty',
          primary: '(no matches)',
          secondary: `nothing matches "${query}"`,
          argv: null,
          destructive: false,
          group: null,
        },
      ];
    }
    if (matches.length === 0) {
      if (outputLines.length === 0) {
        return [
          {
            key: 'empty',
            primary: '(no output)',
            secondary: 'run a /command first',
            argv: null,
            destructive: false,
            group: null,
          },
        ];
      }
      // Empty query: browse the full output.
      return outputLines.map((line, i) => ({
        key: `out:${i}`,
        primary: line,
        secondary: String(i + 1),
        argv: null,
        destructive: false,
        group: null,
      }));
    }
    return matches.map((i) => ({
      key: `out:${i}`,
      primary: outputLines[i] ?? '',
      secondary: String(i + 1),
      argv: null,
      destructive: false,
      group: 'matches',
    }));
  }

  // commands corpus.
  const args = argRequirements(commands, homeSections);
  if (query.length === 0) {
    const rows: PaletteRow[] = [];
    const recents = recentDeduped(recent, commands);
    const recentIds = new Set(recents.map((r) => r.id));
    for (const cmd of recents) {
      rows.push({
        key: `recent:${cmd.id}`,
        primary: cmd.label,
        secondary: cmd.description,
        argv: cmd.argv,
        destructive: cmd.destructive,
        group: 'recent',
        needsArg: requirementFor(args, cmd.argv, cmd.id),
      });
    }
    const homeIds = new Set<string>();
    for (const { group, action } of flattenHome(homeSections)) {
      // Skip a curated action already shown in the recents section, so a command
      // run recently never appears twice (recents + its section) on one screen.
      if (recentIds.has(action.id)) continue;
      const argv = action.dispatch ?? [action.id];
      homeIds.add(action.id);
      rows.push({
        key: `home:${action.id}`,
        primary: action.label,
        secondary: action.hint,
        argv,
        destructive: action.destructive ?? false,
        group,
        needsArg: requirementFor(args, argv, action.id),
      });
    }
    for (const cmd of commands) {
      // Skip commands already shown as a recent or as a curated quick action —
      // the curated label wins over the raw leaf label (one row per command).
      if (recentIds.has(cmd.id) || homeIds.has(cmd.id)) continue;
      rows.push({
        key: `cmd:${cmd.id}`,
        primary: cmd.label,
        secondary: cmd.description,
        argv: cmd.argv,
        destructive: cmd.destructive,
        group: cmd.category,
        needsArg: requirementFor(args, cmd.argv, cmd.id),
      });
    }
    return rows;
  }

  // Non-empty query: fuzzy-rank the full command list.
  return matcher.search(query, commands, MATCH_LIMIT).map((m) => ({
    key: `cmd:${m.item.id}`,
    primary: m.item.label,
    secondary: m.item.description,
    argv: m.item.argv,
    destructive: m.item.destructive,
    group: null,
    needsArg: requirementFor(args, m.item.argv, m.item.id),
  }));
}
