// Reciprocal Rank Fusion (RRF) for hybrid retrieval.
//
// Fuses two pre-ranked retrieval lists — BM25 (`Store.searchFt`) and cosine
// kNN (`Store.knn`) — into one ranked list via the canonical Cormack SIGIR'09
// rank-based formula. RRF is deliberately RANK-BASED: it never reads either
// list's raw scores, so it sidesteps the BM25-vs-cosine scale mismatch
// entirely. A document present in only one list contributes
// only that list's term — no penalty, no normalization — and the raw BM25 and
// cosine scores are NEVER summed.
//
// Reference: Cormack, Clarke, Büttcher — Reciprocal Rank Fusion (SIGIR 2009).
//   score(d) = Σ_i  w_i / (k + rank_i(d))      (1-based ranks, default k = 60)

import type { FtsHit, VecHit } from './types.js';

/**
 * Canonical RRF constant (Cormack SIGIR'09). Larger values dampen the
 * advantage of the top ranks.
 */
export const DEFAULT_RRF_K = 60;

/** Default per-retriever weights `[bm25Weight, kNNWeight]`. */
export const DEFAULT_RRF_WEIGHTS: readonly [number, number] = [0.5, 0.5];

/** Options for {@link fuseRrf}. */
export interface FuseRrfOptions {
  /**
   * RRF constant `k`. Larger values flatten the top-rank advantage.
   * Defaults to {@link DEFAULT_RRF_K} (60 — the canonical value).
   */
  k?: number;
  /**
   * Per-retriever weights `[bm25Weight, kNNWeight]`. Need not sum to 1: RRF is
   * rank-based, not a normalized blend. Defaults to `[0.5, 0.5]`.
   */
  weights?: [number, number];
}

/** A fused result row from {@link fuseRrf}. */
export interface RrfResult {
  /** Chunk id (the same id was indexed into both `docs` and `vec0`). */
  id: string;
  /** Source bucket from the originating hit (bm25's, else kNN's). */
  source: string;
  /**
   * Fused RRF score `Σ w_i/(k+rank_i)`. Rank-based — NOT a normalized
   * similarity; only meaningful for ordering within a single `fuseRrf` call.
   */
  score: number;
}

/**
 * Build a 1-based rank map (`id → {rank, source}`) from a pre-ranked list,
 * taking the FIRST occurrence's position as the rank. Defends against a
 * duplicate id within one list (a well-formed ranking never emits one, but the
 * store does not strictly forbid it); later duplicates are ignored.
 */
function rankMap(
  list: ReadonlyArray<{ id: string; source: string }>,
): Map<string, { rank: number; source: string }> {
  const map = new Map<string, { rank: number; source: string }>();
  for (const [i, hit] of list.entries()) {
    if (map.has(hit.id)) continue; // first occurrence wins
    map.set(hit.id, { rank: i + 1, source: hit.source });
  }
  return map;
}

/**
 * Fuse two pre-ranked retrieval lists via Reciprocal Rank Fusion.
 *
 * The input lists MUST be ordered best-first (the store returns them that way:
 * `searchFt` ranks by BM25 relevance, `knn` by ascending distance). Position in
 * the array IS the rank — the hits' raw `score` fields are intentionally
 * ignored (never sum raw BM25 + cosine).
 *
 * For each unique id: `score = w_bm25/(k + rank_bm25) + w_knn/(k + rank_knn)`,
 * dropping a term when the id is absent from that list (no penalty, no
 * normalization). Results sort by score descending; ties break by the doc's
 * best (minimum) rank across both lists, then by first-seen insertion order
 * (bm25 list first, then kNN-only docs) — all deterministic, so identical
 * inputs always yield identical ordering (NFR-5).
 *
 * Pure and side-effect-free.
 */
export function fuseRrf(
  bm25: ReadonlyArray<FtsHit>,
  knn: ReadonlyArray<VecHit>,
  opts?: FuseRrfOptions,
): RrfResult[] {
  const k = opts?.k ?? DEFAULT_RRF_K;
  const [wBm25, wKnn] = opts?.weights ?? DEFAULT_RRF_WEIGHTS;

  const bm25Ranks = rankMap(bm25);
  const knnRanks = rankMap(knn);

  // Unique ids in first-seen order (bm25 list first, then kNN-only docs).
  // Captured up front so the final tie-break is deterministic without relying
  // on the host JS engine's Array.sort stability.
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const hit of bm25) {
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      orderedIds.push(hit.id);
    }
  }
  for (const hit of knn) {
    if (!seen.has(hit.id)) {
      seen.add(hit.id);
      orderedIds.push(hit.id);
    }
  }

  const entries = orderedIds.map((id, order) => {
    const bm = bm25Ranks.get(id);
    const kn = knnRanks.get(id);
    const rankBm25 = bm?.rank;
    const rankKnn = kn?.rank;
    const score =
      (rankBm25 != null ? wBm25 / (k + rankBm25) : 0) +
      (rankKnn != null ? wKnn / (k + rankKnn) : 0);
    const minRank = Math.min(
      rankBm25 ?? Number.POSITIVE_INFINITY,
      rankKnn ?? Number.POSITIVE_INFINITY,
    );
    // A chunk's source is identical across both lists in practice (the indexer
    // upserts the same id into docs + vec0 with one source), so preferring the
    // bm25 source is a deterministic pick, never a conflicting merge.
    const source = bm?.source ?? kn?.source ?? '';
    return { id, source, score, minRank, order };
  });

  // Sort: fused score desc → best (min) rank asc → first-seen insertion asc.
  entries.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.minRank !== b.minRank) return a.minRank - b.minRank;
    return a.order - b.order;
  });

  // Strip the internal tie-break keys before returning the public shape.
  return entries.map(({ id, source, score }) => ({ id, source, score }));
}
