import { describe, expect, it } from 'vitest';
import { DEFAULT_RRF_K, DEFAULT_RRF_WEIGHTS, fuseRrf } from '../src/rrf.js';
import type { FtsHit, VecHit } from '../src/types.js';

// Minimal hit constructors. RRF is rank-based: it ignores the raw `score`
// field entirely (position in the array is the rank), so the numeric scores
// here are arbitrary placeholders. `snippet`/`meta` are likewise irrelevant to
// fusion — `snippet` is carried on FtsHit by the store and never read here.
function fts(id: string, source = 'codebase', rawScore = 1): FtsHit {
  return { id, source, score: rawScore, snippet: `<${id}>` };
}
function vec(id: string, source = 'codebase', rawScore = 1): VecHit {
  return { id, source, score: rawScore };
}

describe('fuseRrf (Reciprocal Rank Fusion)', () => {
  it('a doc present in both lists outranks a doc in only one', () => {
    // A is rank-1 in both → score 0.5/61 + 0.5/61 = 1/61.
    // B is bm25 rank-2 only → 0.5/62.  C is kNN rank-2 only → 0.5/62.
    const out = fuseRrf([fts('A'), fts('B')], [vec('A'), vec('C')]);
    expect(out.map((r) => r.id)).toEqual(['A', 'B', 'C']);
    const top = out[0];
    if (!top) throw new Error('expected at least one result');
    // exact canonical fused score for a both-lists rank-1 doc (k=60, 0.5/0.5)
    expect(top.score).toBeCloseTo(1 / (DEFAULT_RRF_K + 1), 10);
  });

  it('a doc present in only one list contributes only that list term (no penalty)', () => {
    const onlyBm25 = fuseRrf([fts('X')], []);
    expect(onlyBm25.map((r) => r.id)).toEqual(['X']);
    expect(onlyBm25[0]?.score).toBeCloseTo(0.5 / (DEFAULT_RRF_K + 1), 10);

    const onlyKnn = fuseRrf([], [vec('Y')]);
    expect(onlyKnn.map((r) => r.id)).toEqual(['Y']);
    expect(onlyKnn[0]?.score).toBeCloseTo(0.5 / (DEFAULT_RRF_K + 1), 10);

    // both empty → empty result
    expect(fuseRrf([], [])).toEqual([]);
  });

  it('default k=60 yields the exact canonical score w/(k+rank) for known ranks', () => {
    // bm25-only doc at rank 1 → 0.5/(60+1); at rank 3 → 0.5/(60+3)
    const out = fuseRrf([fts('r1'), fts('x'), fts('r3')], []);
    expect(out[0]?.id).toBe('r1');
    expect(out[0]?.score).toBeCloseTo(DEFAULT_RRF_WEIGHTS[0] / (DEFAULT_RRF_K + 1), 10);
    const r3 = out.find((r) => r.id === 'r3');
    expect(r3?.score).toBeCloseTo(DEFAULT_RRF_WEIGHTS[0] / (DEFAULT_RRF_K + 3), 10);
  });

  it('respects a custom k (score = w/(k+rank))', () => {
    const out = fuseRrf([fts('Q')], [], { k: 1 });
    // 0.5/(1+1) = 0.25
    expect(out[0]?.score).toBeCloseTo(0.25, 10);
  });

  it('respects custom weights — flipping [bm25,knn] weights flips the order', () => {
    // A: bm25#1, kNN#2   B: bm25#2, kNN#1
    const bm25 = [fts('A'), fts('B')];
    const knn = [vec('B'), vec('A')];
    // weight bm25 only → A leads (its bm25 rank is better)
    const bmWeighted = fuseRrf(bm25, knn, { weights: [1, 0] });
    expect(bmWeighted.map((r) => r.id)).toEqual(['A', 'B']);
    // weight kNN only → B leads (its kNN rank is better)
    const knnWeighted = fuseRrf(bm25, knn, { weights: [0, 1] });
    expect(knnWeighted.map((r) => r.id)).toEqual(['B', 'A']);
  });

  it('weights need not sum to 1 (rank-based, not a normalized blend)', () => {
    // [1,1]: a both-lists rank-1 doc → 1/61 + 1/61 = 2/61
    const out = fuseRrf([fts('P')], [vec('P')], { weights: [1, 1] });
    expect(out[0]?.score).toBeCloseTo(2 / (DEFAULT_RRF_K + 1), 10);
  });

  it('never reads raw hit scores — wildly different raw scores fuse identically (AC-3)', () => {
    // Same rankings, but the raw `score` fields differ by orders of magnitude.
    // RRF must ignore them: fused scores must equal the all-ones case.
    const plain = fuseRrf([fts('A'), fts('B')], [vec('A'), vec('C')]);
    const skewed = fuseRrf(
      [fts('A', 'codebase', 9999.999), fts('B', 'codebase', 0.0001)],
      [vec('A', 'codebase', 0.0001), vec('C', 'codebase', 9999.999)],
    );
    expect(skewed.map((r) => r.id)).toEqual(plain.map((r) => r.id));
    expect(skewed.map((r) => r.score)).toEqual(plain.map((r) => r.score));
  });

  it('ignores duplicate ids within a list — first occurrence is the rank', () => {
    // A appears twice in bm25; the rank-1 occurrence must win (not rank-2).
    const out = fuseRrf([fts('A'), fts('A'), fts('B')], []);
    expect(out.map((r) => r.id)).toEqual(['A', 'B']);
    expect(out[0]?.score).toBeCloseTo(0.5 / (DEFAULT_RRF_K + 1), 10);
  });

  it('carries the source bucket on each fused row (bm25 source preferred)', () => {
    // doc in both lists → source comes from the bm25 hit ('docs')
    const both = fuseRrf([fts('A', 'docs')], [vec('A', 'docs')]);
    expect(both[0]?.source).toBe('docs');
    // kNN-only doc → source comes from the kNN hit ('spec')
    const knnOnly = fuseRrf([], [vec('K', 'spec')]);
    expect(knnOnly[0]?.source).toBe('spec');
  });

  it('is deterministic — identical inputs produce identical ordering (NFR-5)', () => {
    const bm25 = [fts('A'), fts('B'), fts('C')];
    const knn = [vec('C'), vec('A'), vec('D')];
    expect(fuseRrf(bm25, knn)).toEqual(fuseRrf(bm25, knn));
  });

  it('breaks score ties by best rank, then first-seen (bm25 before kNN) order', () => {
    // bm25 rank-1 only (0.5/61) vs kNN rank-1 only (0.5/61) → equal score.
    // minRank ties (both 1); first-seen order puts the bm25 doc first.
    const out = fuseRrf([fts('BM')], [vec('KN')]);
    expect(out).toHaveLength(2);
    expect(out[0]?.score).toBe(out[1]?.score);
    expect(out.map((r) => r.id)).toEqual(['BM', 'KN']);
    // re-run is stable
    expect(fuseRrf([fts('BM')], [vec('KN')])).toEqual(out);
  });
});
