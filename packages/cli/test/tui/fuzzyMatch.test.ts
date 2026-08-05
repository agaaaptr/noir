// TDD-A2 — palette fuzzy matcher (hand-rolled scorer). Pure-function tests over
// a fixed palette fixture; no TTY, no daemon, no network. Exercises the
// subsequence scorer (`fuzzyScore`), the per-command field-weighted scorer
// (`matchCommand`), and the `handRolledMatcher` swap seam the TUI will plug any
// future fzf-style matcher into.

import { describe, expect, it } from 'vitest';
import { type FuzzyMatch, fuzzyScore, matchCommand } from '../../src/tui/palette/fuzzyMatch.js';
import { handRolledMatcher } from '../../src/tui/palette/matcher.js';
import type { PaletteCommand } from '../../src/tui/palette/types.js';

// A small but representative palette: label-led commands, one keyword-only alias
// (`snapshot` reachable via the `snap` keyword), so keyword fallback is covered.
// `status` deliberately carries a description that *contains* "start" so the
// label-vs-description tie-break is exercised (the +50 label bonus must win).
// Fields beyond label/keywords/description (argv, category, destructive) are
// filled to satisfy the full PaletteCommand contract the registry emits.
const PALETTE: readonly PaletteCommand[] = [
  {
    id: 'status',
    label: 'status',
    argv: ['status'],
    category: 'status',
    keywords: ['stat'],
    description: 'Start the status report',
    destructive: false,
  },
  {
    id: 'snapshot',
    label: 'snapshot',
    argv: ['task', 'snapshot'],
    category: 'task',
    keywords: ['snap', 'dump'],
    description: 'Capture a workflow snapshot',
    destructive: false,
  },
  {
    id: 'start',
    label: 'start',
    argv: ['task', 'new'],
    category: 'task',
    keywords: ['begin'],
    description: 'Begin a task',
    destructive: true,
  },
  {
    id: 'stop',
    label: 'stop',
    argv: ['daemon', 'stop'],
    category: 'daemon',
    keywords: ['halt'],
    description: 'Stop the daemon',
    destructive: true,
  },
];

// ---- Fixture accessors ------------------------------------------------------
// Non-null-guarded locals so tests never use `!` (biome noNonNullAssertion).
// `statusCmd`/`snapshotCmd`/`startCmd` are the three fixtures the tests index.
// `PALETTE[0]` is `PaletteCommand | undefined` under noUncheckedIndexedAccess;
// a missing fixture is a test-authoring bug, so fail loudly rather than `!`.
function fixtureAt(index: number, name: string): PaletteCommand {
  const cmd = PALETTE[index];
  if (cmd === undefined) throw new Error(`palette fixture '${name}' missing at [${index}]`);
  return cmd;
}
const statusCmd: PaletteCommand = fixtureAt(0, 'status');
const snapshotCmd: PaletteCommand = fixtureAt(1, 'snapshot');
const startCmd: PaletteCommand = fixtureAt(2, 'start');

/** Assert a non-null result (tests expect a match; a null is a test failure). */
function expectMatch(r: { score: number; indices: number[] } | null): {
  score: number;
  indices: number[];
} {
  if (r === null) throw new Error('expected a fuzzyScore match, got null');
  return r;
}

function expectCommandMatch(m: FuzzyMatch | null): FuzzyMatch {
  if (m === null) throw new Error('expected a matchCommand match, got null');
  return m;
}

describe('fuzzyScore', () => {
  it('empty query returns a zero score with no indices', () => {
    expect(fuzzyScore('', 'status')).toEqual({ score: 0, indices: [] });
  });

  it('returns null when the query is not a subsequence of the text', () => {
    expect(fuzzyScore('xyz', 'status')).toBeNull();
  });

  it('matches a prefix subsequence and records the matched indices', () => {
    const r = fuzzyScore('sta', 'status');
    expect(r).not.toBeNull();
    expect(r?.indices).toEqual([0, 1, 2]);
  });

  it('scores a clean prefix match higher than a scattered, gap-heavy match', () => {
    const prefix = expectMatch(fuzzyScore('sta', 'status')); // s(0) t(1) a(2)
    const scattered = expectMatch(fuzzyScore('sts', 'status')); // s(0) t(1) s(4) — gaps
    expect(prefix.score).toBeGreaterThan(scattered.score);
  });
});

describe('matchCommand', () => {
  it('returns null when no field matches the query', () => {
    expect(matchCommand('zzz', statusCmd)).toBeNull();
  });

  it("keeps the best field's matched indices", () => {
    const m = expectCommandMatch(matchCommand('stat', statusCmd));
    expect(m.matchedIndices.length).toBeGreaterThan(0);
  });

  it('matches a query that only appears in a keyword (not in the label)', () => {
    // 'snap' is a keyword of `snapshot`, and also a prefix of its label — but
    // for `dump` (the *other* keyword) we prove keyword matching in isolation.
    const m = expectCommandMatch(matchCommand('dum', snapshotCmd));
    expect(m.item.id).toBe('snapshot');
    expect(m.matchedIndices.length).toBeGreaterThan(0);
  });

  it('the label bonus dominates a strong description hit (label wins ties)', () => {
    // 'start' is the exact label of command #2; it is ALSO a prefix of command
    // #0's description ("Start the status report"). The +50 label bonus must
    // make the label-field win, so command #2 outscores command #0.
    const labelHit = expectCommandMatch(matchCommand('start', startCmd));
    const descHit = expectCommandMatch(matchCommand('start', statusCmd));
    expect(labelHit.score).toBeGreaterThan(descHit.score);
  });
});

describe('handRolledMatcher', () => {
  it('empty query returns every item, score 0, empty indices', () => {
    const out = handRolledMatcher.search('', PALETTE, 10);
    expect(out.length).toBe(PALETTE.length);
    for (const m of out) {
      expect(m.score).toBe(0);
      expect(m.matchedIndices).toEqual([]);
    }
  });

  it("'stat' ranks `status` first (prefix label beat)", () => {
    const out = handRolledMatcher.search('stat', PALETTE, 10);
    expect(out.length).toBeGreaterThan(0);
    expect(out[0]?.item.id).toBe('status');
  });

  it("'snap' reaches `snapshot` via its keyword", () => {
    const out = handRolledMatcher.search('snap', PALETTE, 10);
    const ids = out.map((m) => m.item.id);
    expect(ids).toContain('snapshot');
    // snapshot should be the top hit — 'snap' is an exact keyword prefix.
    expect(out[0]?.item.id).toBe('snapshot');
  });

  it('every returned match carries non-empty matchedIndices', () => {
    const out = handRolledMatcher.search('sta', PALETTE, 10);
    expect(out.length).toBeGreaterThan(0);
    for (const m of out) {
      expect(m.matchedIndices.length).toBeGreaterThan(0);
    }
  });

  it('respects the limit argument (truncates the ranked list)', () => {
    const out = handRolledMatcher.search('s', PALETTE, 2);
    expect(out.length).toBeLessThanOrEqual(2);
    // and the ranking is descending by score
    let prevScore = Number.POSITIVE_INFINITY;
    for (const m of out) {
      expect(m.score).toBeLessThanOrEqual(prevScore);
      prevScore = m.score;
    }
  });

  it('returns an empty array when nothing matches', () => {
    expect(handRolledMatcher.search('zzz', PALETTE, 10)).toEqual([]);
  });
});
