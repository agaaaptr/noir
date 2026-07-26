// SP-C (deferred slice) — findSemanticDuplicates (TDD). A deterministic fake
// embedder maps each text to a hand-set unit vector so cosine + threshold +
// ordering are tested without loading the real MiniLM embedder.
import { describe, expect, it } from 'vitest';
import { DEFAULT_DUP_THRESHOLD, findSemanticDuplicates } from '../src/dedup.js';

/** Fake embedder: text → a fixed vector (caller pre-normalizes). Unknown texts → zero. */
function fakeEmbed(map: Record<string, number[]>): (text: string) => Promise<Float32Array> {
  return async (text: string) => Float32Array.from(map[text] ?? [0, 0, 0]);
}

describe('findSemanticDuplicates', () => {
  it('returns no pairs when all files are orthogonal', async () => {
    const embed = fakeEmbed({ A: [1, 0, 0], B: [0, 1, 0], C: [0, 0, 1] });
    const files = [
      { path: 'A.md', text: 'A' },
      { path: 'B.md', text: 'B' },
      { path: 'C.md', text: 'C' },
    ];
    expect(await findSemanticDuplicates(files, embed, 0.9)).toEqual([]);
  });

  it('returns a pair above threshold, unordered (a ≤ b), sorted desc by similarity', async () => {
    // cos([1,0,0], normalized([0.99,0.14,0])) ≈ 0.9901
    const embed = fakeEmbed({ A: [1, 0, 0], B: [0.99, 0.14, 0], C: [0, 0, 1] });
    const files = [
      { path: 'z.md', text: 'B' }, // paths deliberately out of order
      { path: 'a.md', text: 'A' },
      { path: 'm.md', text: 'C' },
    ];
    const pairs = await findSemanticDuplicates(files, embed, 0.9);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.a).toBe('a.md'); // ordered a ≤ b
    expect(pairs[0]?.b).toBe('z.md');
    expect(pairs[0]?.similarity).toBeGreaterThan(0.9);
  });

  it('respects a lower threshold (catches a borderline pair)', async () => {
    // cos([1,0],[0.8,0.6]) = 0.8 — below 0.9, above 0.75
    const embed = fakeEmbed({ A: [1, 0, 0], B: [0.8, 0.6, 0] });
    const files = [
      { path: 'A.md', text: 'A' },
      { path: 'B.md', text: 'B' },
    ];
    expect(await findSemanticDuplicates(files, embed, 0.9)).toEqual([]);
    expect(await findSemanticDuplicates(files, embed, 0.75)).toHaveLength(1);
  });

  it('skips empty/whitespace-only files', async () => {
    const embed = fakeEmbed({ A: [1, 0, 0] });
    const files = [
      { path: 'A.md', text: 'A' },
      { path: 'empty.md', text: '   ' },
    ];
    expect(await findSemanticDuplicates(files, embed, 0.9)).toEqual([]);
  });

  it('exposes a DEFAULT_DUP_THRESHOLD of 0.9', () => {
    expect(DEFAULT_DUP_THRESHOLD).toBe(0.9);
  });
});
