// SP-D follow-up — mergeThreeWay diff3 (TDD). Pure function; no IO.
import { describe, expect, it } from 'vitest';
import { mergeThreeWay } from '../src/merge.js';

describe('mergeThreeWay — trivial cases', () => {
  it('ours === base → take theirs (user did not edit)', () => {
    expect(mergeThreeWay('a\nb\nc', 'a\nb\nc', 'a\nB\nc')).toEqual({
      merged: 'a\nB\nc',
      conflict: false,
    });
  });
  it('theirs === base → keep ours (template unchanged, user edited)', () => {
    expect(mergeThreeWay('a\nb\nc', 'a\nX\nc', 'a\nb\nc')).toEqual({
      merged: 'a\nX\nc',
      conflict: false,
    });
  });
  it('ours === theirs → keep (both made the same change)', () => {
    expect(mergeThreeWay('a\nb\nc', 'a\nZ\nc', 'a\nZ\nc')).toEqual({
      merged: 'a\nZ\nc',
      conflict: false,
    });
  });
  it('empty base + identical ours/theirs → that content', () => {
    expect(mergeThreeWay('', 'x\ny', 'x\ny')).toEqual({ merged: 'x\ny', conflict: false });
  });
});

describe('mergeThreeWay — disjoint line changes merge cleanly', () => {
  it('user edits one line + template adds a later line → both applied', () => {
    // base: a/b/c ; ours: a/X/c ; theirs: a/b/c/d  → a/X/c/d
    const r = mergeThreeWay('a\nb\nc', 'a\nX\nc', 'a\nb\nc\nd');
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe('a\nX\nc\nd');
  });
  it('user adds a line at top + template adds a line at bottom → both applied', () => {
    const r = mergeThreeWay('m', 'top\nm', 'm\nbot');
    expect(r.conflict).toBe(false);
    expect(r.merged).toBe('top\nm\nbot');
  });
});

describe('mergeThreeWay — overlapping changes conflict', () => {
  it('both edit the same line differently → inline conflict markers', () => {
    const r = mergeThreeWay('a\nb\nc', 'a\nX\nc', 'a\nY\nc');
    expect(r.conflict).toBe(true);
    expect(r.merged).toBe('a\n<<<<<<< ours\nX\n=======\nY\n>>>>>>> theirs\nc');
  });
  it('one side deletes a line the other edits → conflict', () => {
    const r = mergeThreeWay('a\nb\nc', 'a\nc', 'a\nB\nc'); // ours deletes b, theirs edits b
    expect(r.conflict).toBe(true);
    expect(r.merged).toContain('<<<<<<< ours');
    expect(r.merged).toContain('>>>>>>> theirs');
  });
});
