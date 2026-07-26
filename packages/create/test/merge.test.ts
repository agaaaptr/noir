// SP-D follow-up — mergeThreeWay diff3 (TDD). Pure function; no IO.
import { describe, expect, it } from 'vitest';
import { lineDiff, mergeThreeWay, zdiff3Region } from '../src/merge.js';

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

// B2 task 4 — zdiff3 marker shape (`<<<<<<< / ||||||| base / ======= / >>>>>>>`).
// Minimal stays byte-identical to v1.2 (no base section); zdiff3 includes it.
describe('mergeThreeWay — B2 zdiff3 markers', () => {
  it('minimal (default) → no base section (byte-identical to v1.2)', () => {
    const r = mergeThreeWay('L', 'O', 'T');
    expect(r.merged).toBe('<<<<<<< ours\nO\n=======\nT\n>>>>>>> theirs');
    expect(r.merged).not.toContain('|||||||');
  });
  it('zdiff3 → base section between ours and theirs', () => {
    const r = mergeThreeWay('L', 'O', 'T', 'zdiff3');
    expect(r.merged).toBe('<<<<<<< ours\nO\n||||||| base\nL\n=======\nT\n>>>>>>> theirs');
  });
  it('zdiff3Region helper emits the literal marker sequence', () => {
    expect(zdiff3Region(['O'], ['L'], ['T'])).toEqual([
      '<<<<<<< ours',
      'O',
      '||||||| base',
      'L',
      '=======',
      'T',
      '>>>>>>> theirs',
    ]);
  });
});

// B2 task 2 — lineDiff: LCS-based unified line diff for the resolver's stderr
// preview. Pure; mirrors git diff's add/del/eq shape.
describe('lineDiff — B2 unified line diff', () => {
  it('identical content → all eq', () => {
    const d = lineDiff('a\nb', 'a\nb');
    expect(d.every((x) => x.type === 'eq')).toBe(true);
  });
  it('a one-line change → one del + one add', () => {
    const d = lineDiff('a\nb\nc', 'a\nB\nc');
    const dels = d.filter((x) => x.type === 'del');
    const adds = d.filter((x) => x.type === 'add');
    expect(dels).toHaveLength(1);
    expect(adds).toHaveLength(1);
    expect(dels[0]?.line).toBe('b');
    expect(adds[0]?.line).toBe('B');
  });
  it('pure insertion → only adds', () => {
    const d = lineDiff('a\nc', 'a\nb\nc');
    expect(d.filter((x) => x.type === 'add')).toHaveLength(1);
    expect(d.filter((x) => x.type === 'del')).toHaveLength(0);
  });
  it('pure deletion → only dels', () => {
    const d = lineDiff('a\nb\nc', 'a\nc');
    expect(d.filter((x) => x.type === 'del')).toHaveLength(1);
    expect(d.filter((x) => x.type === 'add')).toHaveLength(0);
  });
  it('context-collapse trims long unchanged runs to … sentinels', () => {
    // 20 unchanged lines around a 1-line change. Default context=3 keeps ~7
    // lines around the change; the rest collapse to a single `…` sentinel.
    const base = Array.from({ length: 20 }, (_, i) => `old${i}`).join('\n');
    const head = `${base}\nNEW`;
    const d = lineDiff(base, head, 3);
    // The `…` hunk separator appears at least once (the leading 17 lines
    // collapse; the trailing 3 + NEW stay visible).
    expect(d.some((x) => x.line === '…')).toBe(true);
    // NEW always visible.
    expect(d.some((x) => x.type === 'add' && x.line === 'NEW')).toBe(true);
  });
});
