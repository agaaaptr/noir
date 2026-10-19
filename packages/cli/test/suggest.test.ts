import { describe, expect, it } from 'vitest';
import { closestCommands, levenshtein } from '../src/suggest.js';

describe('levenshtein', () => {
  it('measures the classic edit distance', () => {
    expect(levenshtein('', '')).toBe(0);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
    expect(levenshtein('status', 'status')).toBe(0);
    expect(levenshtein('sync', 'snyc')).toBe(2); // two adjacent swaps
  });
});

describe('closestCommands', () => {
  const commands = ['init', 'create', 'sync', 'status', 'hooks', 'run', 'update'];

  it('suggests the closest command for a typo', () => {
    expect(closestCommands('statsu', commands)).toEqual(['status']);
    expect(closestCommands('snyc', commands)).toEqual(['sync']);
    expect(closestCommands('hooks', commands)).toEqual(['hooks']);
  });

  it('returns multiple candidates at the same minimum distance', () => {
    // "in" is distance 2 from both "init" and "run": both are returned.
    expect(closestCommands('in', commands)).toEqual(['init', 'run']);
    // "rundate" vs "update" (distance 2) is the only candidate within threshold.
    expect(closestCommands('rundate', commands)).toEqual(['update']);
  });

  it('returns nothing when nothing is close enough', () => {
    expect(closestCommands('zzzzzz', commands)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(closestCommands('STATUS', commands)).toEqual(['status']);
  });
});
