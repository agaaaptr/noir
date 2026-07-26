// SP-C (deferred slice) — semantic duplicate detection.
//
// Embeds file contents via an injected EmbedFn (the S6 local embedder in
// production; a deterministic fake in tests) and finds near-duplicate pairs by
// cosine similarity. This is the ONLY mechanism that catches cross-file
// SEMANTIC overlap (e.g. a hand-mirrored CLAUDE.md ≈ AGENTS.md) — exact
// content-hash cannot, because the two files differ byte-wise.

import { l2normalize } from './embedders/normalize.js';
import type { EmbedFn } from './types.js';

export interface DupCandidate {
  /** Path label used only for reporting (repo-relative or absolute). */
  path: string;
  /** Full text content to embed. Empty/whitespace-only files are skipped. */
  text: string;
}

export interface DupPair {
  /** The two near-duplicate paths, ordered `a ≤ b` (each unordered pair once). */
  a: string;
  b: string;
  /** Cosine similarity in [−1, 1] (≥ the threshold). */
  similarity: number;
}

/** Default near-duplicate threshold (cosine). High → few false positives. */
export const DEFAULT_DUP_THRESHOLD = 0.9;

/**
 * Find near-duplicate file pairs by cosine similarity over embedded contents.
 * `embed` is expected to return an L2-normalized vector (the local/remote
 * embedders do); vectors are re-normalized defensively so cosine = dot product.
 * Complexity is O(n²) in the file count — fine for the small candidate set a
 * dedup scan feeds (host context files + `.noir/` docs). Empty-text files are
 * skipped. Returns pairs with similarity ≥ `threshold`, sorted desc, each
 * unordered pair once.
 */
export async function findSemanticDuplicates(
  files: readonly DupCandidate[],
  embed: EmbedFn,
  threshold: number = DEFAULT_DUP_THRESHOLD,
): Promise<DupPair[]> {
  const embedded = await Promise.all(
    files.map(async (f) => {
      if (f.text.trim().length === 0) return { path: f.path, vec: null as Float32Array | null };
      return { path: f.path, vec: l2normalize(await embed(f.text)) };
    }),
  );
  const pairs: DupPair[] = [];
  for (let i = 0; i < embedded.length; i++) {
    const vi = embedded[i];
    if (!vi?.vec) continue;
    for (let j = i + 1; j < embedded.length; j++) {
      const vj = embedded[j];
      if (!vj?.vec) continue;
      const sim = dot(vi.vec, vj.vec);
      if (sim >= threshold) {
        const [a, b] = vi.path <= vj.path ? [vi.path, vj.path] : [vj.path, vi.path];
        pairs.push({ a, b, similarity: sim });
      }
    }
  }
  pairs.sort((x, y) => y.similarity - x.similarity);
  return pairs;
}

/** Dot product (both vectors assumed L2-normalized ⇒ cosine similarity). */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
