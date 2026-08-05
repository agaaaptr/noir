// The matcher swap seam. `FuzzyMatcher` is the interface the TUI depends on;
// `handRolledMatcher` is the default, dependency-free implementation built on
// `matchCommand`. Swapping in a native fzf/ItsFuzzy binding later means shipping
// a second `FuzzyMatcher` — the palette code never changes.

import { type FuzzyMatch, matchCommand } from './fuzzyMatch.js';
import type { PaletteCommand } from './types.js';

/**
 * What the palette asks for: "rank these items against this query, capped at
 * `limit`". Implementations must be deterministic and side-effect free.
 */
export interface FuzzyMatcher {
  search(query: string, items: readonly PaletteCommand[], limit: number): FuzzyMatch[];
}

/**
 * Default matcher. Empty query returns every item (score 0, empty indices) so
 * the palette can render the full list before the user types; otherwise each
 * item is scored, filtered to matches, sorted by descending score, and sliced
 * to `limit`. Sort is stable (ties keep input order) via a Array.prototype.sort
 * that only reorders on a strict score difference.
 */
export const handRolledMatcher: FuzzyMatcher = {
  search(query: string, items: readonly PaletteCommand[], limit: number): FuzzyMatch[] {
    if (query.length === 0) {
      return items.slice(0, Math.max(0, limit)).map((item) => ({
        item,
        score: 0,
        matchedIndices: [],
      }));
    }

    const matched: FuzzyMatch[] = [];
    for (const item of items) {
      const m = matchCommand(query, item);
      if (m) matched.push(m);
    }

    matched.sort((a, b) => b.score - a.score);
    return matched.slice(0, Math.max(0, limit));
  },
};
