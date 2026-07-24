// Shared numeric helpers for every embedder in this package.
//
// All embedder implementations (local / remote / ollama / fake) funnel their
// final vector through `l2normalize` so that:
//   - the existing S1 `vec0` table (created with the DEFAULT distance metric)
//     yields cosine-equivalent ranking when vectors are unit-norm (spec DS-8),
//   - remote/ollama vectors that were Matryoshka-truncated to `EMBED_DIM` are
//     re-normalized client-side (truncation shrinks the norm),
//   - the kNN path sees a single, consistent scale regardless of provider.
//
// `EMBED_DIM` is the fixed width of the vec0 table (384). It is the single
// source of truth for the target dimensionality and matches the MiniLM-L6-v2
// default model — changing it would require a store schema migration, which
// S6 explicitly does NOT do.

/**
 * Fixed embedding width. Matches the S1 `vec0(float[384])` virtual table and
 * the default `all-MiniLM-L6-v2` model. Remote/ollama vectors are truncated or
 * required to be >= this width (see `remote.ts` / `ollama.ts`).
 */
export const EMBED_DIM = 384;

/**
 * Return a unit-norm copy of `vec` (L2 normalization). The input is never
 * mutated. Length is preserved: callers responsible for ensuring the vector is
 * already `EMBED_DIM`-wide (truncate BEFORE normalizing — Matryoshka order
 * matters; normalizing then truncating would distort directions).
 *
 * A zero-length or all-zero / non-finite input cannot be normalized; for those
 * degenerate cases a fresh zeroed vector of the same length is returned rather
 * than inventing directional signal or producing NaN. Real embedders never
 * emit such vectors; this guard exists purely for robustness.
 */
export function l2normalize(vec: Float32Array): Float32Array {
  const n = vec.length;
  if (n === 0) return new Float32Array(0);

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = vec[i];
    if (v !== undefined) sum += v * v;
  }
  const norm = Math.sqrt(sum);
  // norm === 0 (all-zero input) or NaN/Infinity → return zeros, no signal invented.
  if (norm === 0 || !Number.isFinite(norm)) {
    return new Float32Array(n);
  }

  const out = new Float32Array(n);
  const inv = 1 / norm;
  for (let i = 0; i < n; i++) {
    const v = vec[i];
    if (v !== undefined) out[i] = v * inv;
  }
  return out;
}
