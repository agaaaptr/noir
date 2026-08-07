// B2 — the command palette overlay.
//
// A fuzzy-find over the registered {@link PaletteCommand}s. Owns its own query +
// active-row state and routes its OWN keys via `useInput` (the App routes all
// input to the palette while `mode.kind === 'palette'`; the App's single
// keybinding dispatcher returns early in palette mode so the palette's handler
// is the sole consumer of those keystrokes). On every render it re-runs the
// matcher (`matcher.search(query, commands, 20)`); with an empty query it shows
// the recent commands first, then the full list grouped by category. ↑/↓ move
// the active row (clamped); Enter selects; Esc closes.
//
// Match highlighting uses `matchedIndices` from the matcher — matched chars are
// drawn in the brand accent (`c.accent`) — and the visible list is clamped to
// ~10 rows so the overlay never floods the dashboard.
//
// Presentational contract: the component never dispatches and never touches
// history. `onSelect` / `onClose` are the only exits, so the App (which owns the
// dispatch seam + confirmation routing) stays the single decision-maker.

import { Box, Text, useInput } from 'ink';
import { type ReactElement, useState } from 'react';
import { c } from '../../theme.js';
import { Panel } from '../Panel.js';
import type { FuzzyMatcher } from './matcher.js';
import type { PaletteCommand } from './types.js';

const PALETTE_WIDTH = 64;

/** How many rows the overlay shows at most (a comfortable half-screen). */
const VISIBLE_ROWS = 10;
/** Ranked-result cap the matcher is asked for on a non-empty query. */
const MATCH_LIMIT = 20;

/** The palette's props — supplied by the App (which owns dispatch + history). */
export interface PaletteProps {
  /** The full palette source, derived from the commander tree. */
  readonly commands: readonly PaletteCommand[];
  /** The fuzzy matcher (the `handRolledMatcher` swap seam). */
  readonly matcher: FuzzyMatcher;
  /** Recently-run commands, newest first, shown above the list on empty query. */
  readonly recent: readonly PaletteCommand[];
  /** Called with the selected command on Enter. */
  onSelect: (cmd: PaletteCommand) => void;
  /** Called on Esc — the App returns to the dashboard. */
  onClose: () => void;
}

/** A ranked palette row: the command + its matcher highlight indices. */
interface RankedHit {
  cmd: PaletteCommand;
  indices: readonly number[];
}

/**
 * Rank `commands` against `query`. Empty query → the recent commands (deduped
 * against the full list) first, then the full list; a non-empty query → the
 * matcher's top hits (indices retained for highlight).
 */
function rankPalette(
  query: string,
  matcher: FuzzyMatcher,
  commands: readonly PaletteCommand[],
  recent: readonly PaletteCommand[],
): RankedHit[] {
  if (query.length === 0) {
    const recents = recentDeduped(recent, commands);
    const recentIds = new Set(recents.map((r) => r.id));
    const rest = commands.filter((cmd) => !recentIds.has(cmd.id));
    return [
      ...recents.map((cmd) => ({ cmd, indices: [] as readonly number[] })),
      ...rest.map((cmd) => ({ cmd, indices: [] as readonly number[] })),
    ];
  }
  return matcher.search(query, commands, MATCH_LIMIT).map((m) => ({
    cmd: m.item,
    indices: m.matchedIndices,
  }));
}

/**
 * Truncate a command label to fit the fixed-width palette. Each visible row
 * carries prefix (2) + label + hint (~30); cap the label so the row never
 * overflows the panel.
 */
function truncateLabel(label: string): string {
  const max = Math.max(20, PALETTE_WIDTH - 8);
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

/** Highlight matched chars of `label` using `matchedIndices` (brand accent). */
function highlight(label: string, matchedIndices: readonly number[]): ReactElement {
  const set = new Set(matchedIndices);
  const chars: ReactElement[] = [];
  for (let i = 0; i < label.length; i++) {
    const ch = label[i] ?? '';
    chars.push(set.has(i) ? <Text key={i}>{c.accent(ch)}</Text> : <Text key={i}>{ch}</Text>);
  }
  return <>{chars}</>;
}

/**
 * Render the palette overlay: an input row + the ranked/recent command list.
 * State is local (query + active index); every render re-derives the list from
 * the props so the matcher result can never go stale. Enter selects
 * `visible[activeIndex]` (the top of the ranked list by default); Esc closes.
 */
export function Palette({
  commands,
  matcher,
  recent,
  onSelect,
  onClose,
}: PaletteProps): ReactElement {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  // Ranked matches for the current query. Empty query → `recent` (deduped
  // against the full list) followed by the full list; non-empty → matcher hits.
  const ranked = rankPalette(query, matcher, commands, recent);
  const visible = ranked.slice(0, VISIBLE_ROWS);
  // Clamp the active row into range so a stale index (e.g. after the list
  // shrinks mid-search) never highlights a row that isn't rendered.
  const active = Math.min(Math.max(activeIndex, 0), Math.max(0, visible.length - 1));
  // The recents that still exist in the full command list (for the ↺ marker +
  // the `── recent ──` section header on an empty query).
  const recents = recentDeduped(recent, commands);

  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (key.return) {
      const hit = visible[active];
      if (hit) onSelect(hit.cmd);
      return;
    }
    if (key.upArrow) {
      setActiveIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setActiveIndex((i) => i + 1); // clamped at render
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setActiveIndex(0);
      return;
    }
    if (key.ctrl) return; // swallow other Ctrl-combos
    if (input.length > 0) {
      setQuery((q) => q + input);
      setActiveIndex(0);
    }
  });

  // Render the overlay as a column of Text rows (one line per row, like
  // OutputPane). On an empty query the list is `recent` first, then the full
  // list grouped by category via inline dim headers.
  const rows: ReactElement[] = [
    <Box key="header" paddingX={1}>
      <Text>
        {c.bold('▸ palette ')}
        <Text>{c.dim(`search (${visible.length} shown)`)}</Text>
      </Text>
    </Box>,
    <Box key="query" paddingX={1}>
      <Text>
        {c.dim('> ')}
        {query}
        <Text>{c.dim('▌')}</Text>
      </Text>
    </Box>,
  ];

  let lastCategory: string | null = null;
  for (const { cmd, indices } of visible) {
    const isRecent = recents.some((r) => r.id === cmd.id);
    // On an empty query, a `── recent ──` header separates the recents from the
    // full list; afterwards (and on a search) the list is grouped by category.
    if (query.length === 0) {
      if (isRecent && lastCategory !== 'recent') {
        rows.push(
          <Box key="cat:recent" paddingX={1}>
            <Text>{c.dim('── recent ──')}</Text>
          </Box>,
        );
        lastCategory = 'recent';
      } else if (!isRecent && cmd.category !== lastCategory) {
        rows.push(
          <Box key={`cat:${cmd.category}`} paddingX={1}>
            <Text>{c.dim(`── ${cmd.category} ──`)}</Text>
          </Box>,
        );
        lastCategory = cmd.category;
      }
    }
    const prefix = cmd.id === visible[active]?.cmd.id ? '▸ ' : '  ';
    rows.push(
      <Box key={cmd.id} paddingX={1}>
        <Text>
          {isRecent && query.length === 0 ? <Text>{c.dim('↺ ')}</Text> : null}
          {prefix}
          {highlight(truncateLabel(cmd.label), indices)}
          <Text>{c.dim(`  ${cmd.description}`)}</Text>
        </Text>
      </Box>,
    );
  }

  return (
    <Box flexDirection="column">
      <Panel maxWidth={PALETTE_WIDTH}>{rows}</Panel>
      <Text>{c.dim('↑/↓ navigate · Enter run · Esc close')}</Text>
    </Box>
  );
}

/** `recent` entries that still exist in `commands`, in recent order. */
function recentDeduped(
  recent: readonly PaletteCommand[],
  commands: readonly PaletteCommand[],
): PaletteCommand[] {
  const known = new Set(commands.map((cmd) => cmd.id));
  return recent.filter((cmd) => known.has(cmd.id));
}
