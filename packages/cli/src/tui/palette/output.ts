// Output-search primitives (moved from the retired `overlays/SearchMode.ts`).
//
// Pure, framework-free functions the palette's `output` corpus consumes:
// `computeMatches` turns a query into the line indices that contain it. The
// `/` dispatch prefix makes '/' unusable as a search key, so Ctrl+F (or the
// palette `Tab` switch) is the entry into this corpus.

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
