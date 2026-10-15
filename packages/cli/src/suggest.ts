// Typo-friendly command suggestion. Commander's own `.showSuggestionAfterError()`
// covers unknown OPTIONS, but the program-level fallback action handles unknown
// COMMANDS itself, so it needs its own "did you mean" hint. A bare Levenshtein
// distance + nearest-candidate picker is enough at command-name length —
// commander's built-in suggestion uses full Damerau–Levenshtein, but a
// transposition rarely changes which command is closest, so this stays stdlib-only.

/** Classic Levenshtein edit distance (insert / delete / substitute). */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  // Two rolling rows. Every index 0..n is written before it is read, so the
  // `?? 0` fallbacks are a noUncheckedIndexedAccess type-level only — they never
  // actually trigger.
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a[i - 1];
    for (let j = 1; j <= n; j++) {
      const substitution = (prev[j - 1] ?? 0) + (ai === b[j - 1] ? 0 : 1);
      const insertion = (curr[j - 1] ?? 0) + 1;
      const deletion = (prev[j] ?? 0) + 1;
      curr[j] = Math.min(substitution, insertion, deletion);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/**
 * The candidate(s) closest to `input`, case-insensitive, within an edit-distance
 * threshold (up to `max` results, all at the same minimum distance). Empty when
 * nothing is close enough — the caller then omits the "did you mean" hint.
 */
export function closestCommands(input: string, candidates: string[], max = 3): string[] {
  const needle = input.toLowerCase();
  const threshold = Math.max(3, Math.floor(needle.length / 2));
  let best: string[] = [];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of candidates) {
    const d = levenshtein(needle, c.toLowerCase());
    if (d > threshold) continue;
    if (d < bestDist) {
      bestDist = d;
      best = [c];
    } else if (d === bestDist) {
      best.push(c);
    }
  }
  return best.slice(0, max);
}
