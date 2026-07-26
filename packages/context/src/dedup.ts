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

/** Default near-duplicate threshold (cosine) for the O(n²) pair scan. High →
 *  few false positives. Used by `noir doctor --dedup` over the candidate set. */
export const DEFAULT_DUP_THRESHOLD = 0.9;

/** Default near-duplicate threshold (cosine) for the O(n) write-path scan
 *  (`findNearestDuplicate`). Lower (0.85) so the write-path hook surfaces BOTH
 *  the action tier (≥ 0.95) AND the info-only tier (0.85–0.95); the doctor's
 *  0.90 would silently swallow the 0.85–0.90 info band. */
export const NEAREST_DUP_DEFAULT_THRESHOLD = 0.85;

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

/**
 * Find the single NEAREST duplicate of `proposed` among `candidates` by cosine
 * similarity. The write-path analog of {@link findSemanticDuplicates}: same
 * embedding + cosine math, but O(n) (one proposed vs N candidates) instead of
 * O(n²), and returns a single best match (or null) rather than a pair list.
 *
 * Used by the `noir init`/`create`/`sync` write-path dedup hook:
 * AFTER scaffold writes a host-context file, the CLI reads its bytes as
 * `proposed` and the OTHER existing host-context files as `candidates`. Empty-
 * text inputs (proposed or any candidate) are skipped. Returns the best pair
 * with similarity ≥ `threshold`, ordered `a ≤ b`, or null when nothing matches.
 *
 * The caller owns embedding-caching policy (the CLI hook wraps `embed` with a
 * SHA-256 content-hash cache so unchanged candidates skip the embedder on
 * repeat `noir sync`). This pure function does NOT touch the cache itself.
 */
export async function findNearestDuplicate(
  proposed: DupCandidate,
  candidates: readonly DupCandidate[],
  embed: EmbedFn,
  threshold: number = NEAREST_DUP_DEFAULT_THRESHOLD,
): Promise<DupPair | null> {
  if (proposed.text.trim().length === 0) return null;
  const proposedVec = l2normalize(await embed(proposed.text));
  let best: DupPair | null = null;
  for (const c of candidates) {
    if (c.text.trim().length === 0) continue;
    const v = l2normalize(await embed(c.text));
    const sim = dot(proposedVec, v);
    if (sim >= threshold && (best === null || sim > best.similarity)) {
      const [a, b] = proposed.path <= c.path ? [proposed.path, c.path] : [c.path, proposed.path];
      best = { a, b, similarity: sim };
    }
  }
  return best;
}

/** Dot product (both vectors assumed L2-normalized ⇒ cosine similarity). */
function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
