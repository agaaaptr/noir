// Deterministic fake embedder for TESTS ONLY (no production path consumes it —
// the `kind:'none'` branch throws its own stub rather than returning a fake).
//
// DESIGN (spec §13 / NFR-2 / NFR-5):
//   - The full unit suite runs OFFLINE with no model download and no network.
//     `fakeEmbedFn` is the deterministic stand-in: same text → same vector,
//     different text → different direction, always `EMBED_DIM`-wide and
//     unit-norm. This makes chunker/rrf/retriever/indexer tests reproducible.
//   - Determinism comes from a SHA-256 of the text (no RNG, no clock) —
//     identical inputs produce bit-identical vectors (NFR-5).
//   - Output is L2-normalized through the shared helper so it is
//     indistinguishable from a real embedder at the store boundary.

import { createHash } from 'node:crypto';
import type { EmbedFn } from '../types.js';
import { EMBED_DIM, l2normalize } from './normalize.js';

/**
 * Build a deterministic embedder. The returned function maps each input string
 * to a stable, unit-norm `EMBED_DIM`-wide `Float32Array` derived from a SHA-256
 * hash of the text. TEST-ONLY (no production path consumes it — the `kind:none`
 * branch throws its own stub rather than returning a fake).
 *
 * @param dim output width (defaults to {@link EMBED_DIM} = 384)
 */
export function fakeEmbedFn(dim: number = EMBED_DIM): EmbedFn {
  return (text: string): Promise<Float32Array> => {
    const hash = createHash('sha256').update(text, 'utf8').digest();
    const raw = new Float32Array(dim);
    // Spread the 32 hash bytes deterministically across the `dim` slots. Values
    // land in [-1, 1) (signed byte / 128); the direction is what matters and is
    // normalized away from the scale by `l2normalize`.
    for (let i = 0; i < dim; i++) {
      const byte = hash[i % hash.length];
      if (byte !== undefined) raw[i] = (byte - 128) / 128;
    }
    return Promise.resolve(l2normalize(raw));
  };
}
