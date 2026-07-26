// SP-C (deferred slice) — findSemanticDuplicates + findNearestDuplicate (TDD).
// A deterministic fake embedder maps each text to a hand-set unit vector so
// cosine + threshold + ordering are tested without loading the real MiniLM
// embedder.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUP_THRESHOLD,
  findNearestDuplicate,
  findSemanticDuplicates,
  NEAREST_DUP_DEFAULT_THRESHOLD,
} from '../src/dedup.js';

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

describe('findNearestDuplicate', () => {
  it('returns null when no candidate reaches the threshold', async () => {
    const embed = fakeEmbed({ P: [1, 0, 0], A: [0, 1, 0], B: [0, 0, 1] });
    const proposed = { path: 'P.md', text: 'P' };
    const candidates = [
      { path: 'A.md', text: 'A' },
      { path: 'B.md', text: 'B' },
    ];
    expect(await findNearestDuplicate(proposed, candidates, embed, 0.85)).toBeNull();
  });

  it('returns the single best match above threshold, ordered a ≤ b', async () => {
    // cos([1,0,0], normalized([0.99,0.14,0])) ≈ 0.9901; cos([1,0,0],[0.8,0.6,0]) = 0.8
    const embed = fakeEmbed({
      P: [1, 0, 0],
      near: [0.99, 0.14, 0],
      far: [0.8, 0.6, 0],
    });
    const proposed = { path: 'proposed.md', text: 'P' };
    const candidates = [
      { path: 'zz-far.md', text: 'far' },
      { path: 'aa-near.md', text: 'near' },
    ];
    const best = await findNearestDuplicate(proposed, candidates, embed, 0.85);
    expect(best).not.toBeNull();
    expect(best?.a).toBe('aa-near.md'); // ordered a ≤ b against 'proposed.md'
    expect(best?.b).toBe('proposed.md');
    expect(best?.similarity).toBeGreaterThan(0.95);
  });

  it('picks the HIGHER-similarity candidate when two both clear the threshold', async () => {
    const embed = fakeEmbed({
      P: [1, 0, 0],
      lo: [0.9, 0.43, 0], // cos ≈ 0.902
      hi: [0.99, 0.14, 0], // cos ≈ 0.990
    });
    const proposed = { path: 'P.md', text: 'P' };
    const candidates = [
      { path: 'lo.md', text: 'lo' },
      { path: 'hi.md', text: 'hi' },
    ];
    const best = await findNearestDuplicate(proposed, candidates, embed, 0.85);
    expect(best?.a).toBe('P.md');
    expect(best?.b).toBe('hi.md'); // the higher-similarity one wins
  });

  it('skips empty/whitespace proposed + candidates (no signal invented)', async () => {
    const embed = fakeEmbed({ P: [1, 0, 0] });
    const proposed = { path: 'P.md', text: '   ' }; // empty → return null
    const candidates = [{ path: 'A.md', text: 'A' }];
    expect(await findNearestDuplicate(proposed, candidates, embed, 0.85)).toBeNull();

    const proposed2 = { path: 'P.md', text: 'P' };
    const candidates2 = [
      { path: 'empty.md', text: '   ' },
      { path: 'A.md', text: 'A' }, // map has no 'A' → zero vec → cosine 0 < 0.85
    ];
    expect(await findNearestDuplicate(proposed2, candidates2, embed, 0.85)).toBeNull();
  });

  it('returns null with zero candidates (fresh-project fast path)', async () => {
    const embed = fakeEmbed({ P: [1, 0, 0] });
    const proposed = { path: 'P.md', text: 'P' };
    expect(await findNearestDuplicate(proposed, [], embed, 0.85)).toBeNull();
  });

  it('exposes NEAREST_DUP_DEFAULT_THRESHOLD of 0.85', () => {
    expect(NEAREST_DUP_DEFAULT_THRESHOLD).toBe(0.85);
  });
});
