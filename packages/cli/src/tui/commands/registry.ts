// A1 — derive {@link PaletteCommand} entries from a commander program.
//
// The TUI command palette needs a flat, searchable list of the `noir`
// subcommands a user can dispatch. Rather than maintain a second hand-curated
// command table (which would drift from the real tree in `bin.ts`), this module
// walks the commander tree at palette-build time and projects each LEAF command
// into a {@link PaletteCommand}.
//
// Leaf contract (mirrors the palette's intent — only dispatchable commands
// surface, never bare groups):
//   - has an action handler (`.action()` was called), AND
//   - has no child commands.
// Groups — which own children and carry a usage-throwing fallback action in the
// real CLI — are excluded by the "no children" clause regardless of their action
// state. The program root name ('noir' / '') is never part of the argv path.

import type { Command } from 'commander';
import type { PaletteCommand } from '../palette/types.js';

/**
 * argv-prefix table for commands that mutate the store / workflow / host
 * artifacts. The palette uses this to require confirmation before dispatch.
 * A prefix matches when `commandArgv` starts with every token of the entry
 * (e.g. `['context', 'index']` matches the `context index` leaf).
 */
const DESTRUCTIVE_PREFIXES: readonly (readonly string[])[] = [
  ['context', 'index'],
  ['memory', 'save'],
  ['memory', 'forget'],
  ['memory', 'consolidate'],
  ['task', 'new'],
  ['task', 'advance'],
  ['skills', 'sync'],
  ['daemon', 'start'],
  ['daemon', 'stop'],
  ['daemon', 'restart'],
  ['init'],
  ['create'],
  ['sync'],
  ['install'],
  ['update'],
  ['run'],
];

/**
 * True when `argv` matches one of the {@link DESTRUCTIVE_PREFIXES}. A prefix
 * matches iff `argv` is at least as long as the prefix and every prefix token
 * equals the corresponding argv token — so `['context']` does NOT match the
 * `['context', 'index']` prefix (a bare group isn't destructive), but
 * `['context', 'index']` does.
 */
export function isDestructive(argv: readonly string[]): boolean {
  return DESTRUCTIVE_PREFIXES.some((prefix) => {
    if (argv.length < prefix.length) return false;
    return prefix.every((tok, i) => argv[i] === tok);
  });
}

/** Capitalize the first character of `s`, leaving the rest untouched. */
function capitalizeFirst(s: string): string {
  if (s.length === 0) return s;
  return `${s[0]?.toUpperCase() ?? ''}${s.slice(1)}`;
}

/**
 * Commander keeps the registered action handler on a private `_actionHandler`
 * field (no public accessor exists). This narrow cast reads only that field so
 * we can tell "a dispatchable command" apart from "a bare group container".
 */
type CommandWithAction = Command & { _actionHandler: ((...args: unknown[]) => unknown) | null };

/** True when commander has an `.action()` handler registered on `cmd`. */
function hasAction(cmd: Command): boolean {
  return (cmd as CommandWithAction)._actionHandler != null;
}

/**
 * Walk `cmd`'s subtree depth-first, appending one {@link PaletteCommand} per
 * leaf (has an action handler AND no child commands). `path` accumulates the
 * argv tokens excluding the program root name; the caller seeds it as `[]` so
 * the root contributes nothing.
 */
function collectLeaves(cmd: Command, path: string[], out: PaletteCommand[]): void {
  const children = cmd.commands;
  const isLeaf = hasAction(cmd) && children.length === 0;

  if (isLeaf) {
    const argv = path;
    const id = argv.join(' ');
    const description = cmd.description() || argv.join(' ');
    out.push({
      id,
      label: argv.map(capitalizeFirst).join(': '),
      argv,
      description,
      category: argv[0] ?? '',
      keywords: argv,
      destructive: isDestructive(argv),
    });
    return;
  }

  // Not a leaf — recurse into each child, extending the path with its name.
  // A child `name()` is always a non-empty token (commander rejects empty
  // command names), so `path` only grows with real argv segments.
  for (const child of children) {
    collectLeaves(child, [...path, child.name()], out);
  }
}

/**
 * Derive the palette entries for `program`: one {@link PaletteCommand} per leaf
 * subcommand, in commander's registration order. The program root name
 * ('noir' / '') is never part of any entry's argv.
 */
export function buildPaletteCommands(program: Command): PaletteCommand[] {
  const out: PaletteCommand[] = [];
  // Seed the path empty so the root's own name is excluded; its children become
  // the top-level argv segments (e.g. `context`, `doctor`, `init`).
  collectLeaves(program, [], out);
  return out;
}
