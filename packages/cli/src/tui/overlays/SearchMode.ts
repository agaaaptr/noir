// C2 — output-pane search primitives. Pure, framework-free functions the App's
// search screen consumes: `SearchState` is the discriminated search payload and
// `computeMatches` turns a query into the line indices that contain it.
//
// Key-collision note (RESOLVES spec T7 '/' ambiguity): the dashboard input uses
// '/' as the dispatch prefix, so '/' can never enter search — Ctrl+F is the
// entry key (wired in App.tsx). Search is a substring filter, not a dispatch:
// it never touches the buffer, the history, or the dispatch seam.

/** The search screen's live state: the query + the output lines it matches. */
export interface SearchState {
  /** The current query ('' = nothing typed yet). */
  query: string;
  /**
   * Indices into the output's `lines` whose text contains the query, in line
   * order. Empty when the query is empty or nothing matches.
   */
  matches: number[];
  /**
   * Index into `matches` of the active match, or `-1` when there is none. The
   * App renders `lines[matches[active]]` as the accented line in the pane.
   */
  active: number;
}

/** The search state for a freshly-opened search (nothing typed yet). */
export const emptySearch: SearchState = {
  query: '',
  matches: [],
  active: -1,
};

/**
 * Line indices whose (case-insensitive) text contains `query`, in line order.
 * An empty query matches nothing (`[]`) — the search only starts once the user
 * types, and an empty query must never be treated as "matches every line".
 */
export function computeMatches(lines: readonly string[], query: string): number[] {
  if (query.length === 0) return [];
  const needle = query.toLowerCase();
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? '').toLowerCase().includes(needle)) out.push(i);
  }
  return out;
}
