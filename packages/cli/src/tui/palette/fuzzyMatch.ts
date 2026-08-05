// Hand-rolled fuzzy scorer for the command palette. This is the swap seam:
// `fuzzyScore` + `matchCommand` are pure functions a future fzf/ItsFuzzy-style
// matcher can replace without touching the TUI; `FuzzyMatch` is the shared
// result shape both the matcher and the rendering layer speak.
//
// Design notes:
// - Subsequence matcher (not substring): "sts" matches "status" (s, t, s).
// - Case-insensitive — both sides lowercased before comparison.
// - Gap penalty (-0.1 per skipped char) makes tight matches beat scattered ones.
// - Consecutive bonus (+8) rewards runs like a real fuzzy finder.
// - Prefix bonus (+4 while text-index < query.length) makes a leading match
//   dominate a trailing one, so "sta" ranks above a "status"-tail hit.

import type { PaletteCommand } from './types.js';

/** A scored palette hit returned by the matcher. */
export interface FuzzyMatch {
  item: PaletteCommand;
  score: number;
  /** Text indices of the best-scoring field that matched (for highlight). */
  matchedIndices: number[];
}

/** Field weights — label dominates so titles win ties over help text. */
const WEIGHTS = {
  label: 1.0,
  keyword: 0.7,
  description: 0.5,
} as const;

/** Flat bonus added to the label field so it wins cross-field ties. */
const LABEL_TIE_BONUS = 50;

/**
 * Score `query` against `text` as a (case-insensitive) subsequence. Returns
 * `{score, indices}` when every query char is matched in order, else `null`.
 * An empty query scores 0 with no indices.
 */
export function fuzzyScore(
  query: string,
  text: string,
): { score: number; indices: number[] } | null {
  if (query.length === 0) return { score: 0, indices: [] };

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let prevMatchedIndex = -1;

  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      indices.push(ti);
      // consecutive-match bonus: only when this char directly follows the
      // previous matched char (a real fuzzy-finder "run" reward).
      const consecutive = prevMatchedIndex !== -1 && ti === prevMatchedIndex + 1;
      if (consecutive) score += 8;
      if (ti < q.length) score += 4; // prefix-region bonus
      // gap penalty for chars skipped between matches
      if (prevMatchedIndex !== -1) {
        const skipped = ti - prevMatchedIndex - 1;
        if (skipped > 0) score -= 0.1 * skipped;
      }
      prevMatchedIndex = ti;
      qi++;
    }
  }

  if (qi < q.length) return null; // query not a full subsequence
  return { score, indices };
}

/**
 * Score a single command across its label / keywords / description, returning
 * the best field's weighted result (plus the flat label tie-break bonus so a
 * label hit always wins a tie against a keyword or description hit). Returns
 * `null` when the query matches no field.
 */
export function matchCommand(query: string, item: PaletteCommand): FuzzyMatch | null {
  if (query.length === 0) {
    return { item, score: 0, matchedIndices: [] };
  }

  // Track the best field hit. Kept as a mutable holder (rather than a
  // `| null` union) so the `consider` closure can read the running high score
  // without TypeScript narrowing it to `never` across the conditional updates.
  const best: { score: number; indices: number[] } = {
    score: Number.NEGATIVE_INFINITY,
    indices: [],
  };
  let matched = false;

  // Replace the running best if `candidate` scores higher.
  const consider = (score: number, indices: number[]): void => {
    if (!matched || score > best.score) {
      best.score = score;
      best.indices = indices;
      matched = true;
    }
  };

  // Label — weighted highest, plus the flat tie-break bonus.
  const labelHit = fuzzyScore(query, item.label);
  if (labelHit) {
    consider(labelHit.score * WEIGHTS.label + LABEL_TIE_BONUS, labelHit.indices);
  }

  // Keywords — each scored independently, best keyword wins the field.
  if (item.keywords) {
    let bestKw: { score: number; indices: number[] } | null = null;
    for (const kw of item.keywords) {
      const kwHit = fuzzyScore(query, kw);
      if (kwHit && (bestKw === null || kwHit.score > bestKw.score)) bestKw = kwHit;
    }
    if (bestKw) {
      consider(bestKw.score * WEIGHTS.keyword, bestKw.indices);
    }
  }

  // Description — lowest weight, last resort.
  if (item.description) {
    const descHit = fuzzyScore(query, item.description);
    if (descHit) {
      consider(descHit.score * WEIGHTS.description, descHit.indices);
    }
  }

  if (!matched) return null;
  return { item, score: best.score, matchedIndices: best.indices };
}
