import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  discoverBuiltin,
  looksLikeWhenDescription,
  validateSkill,
} from '../src/compiler.js';
import { FORBIDDEN_RESIDUE } from '../src/residue.js';

const skills = discoverBuiltin();
const byName = new Map(skills.map((s) => [s.name, s]));

/** Returns the named skill, throwing if absent — a type-safe replacement for
 *  `const s = byName.get(name); expect(s).toBeDefined(); …s?.skillMd`, which
 *  under noUncheckedIndexedAccess leaks `string | undefined` into bodyOf. */
function getOrFail(name: string) {
  const s = byName.get(name);
  if (!s) throw new Error(`missing ${name}`);
  return s;
}

const FULL_LIFECYCLE = [
  'noir-intake',
  'noir-clarify',
  'noir-spec',
  'noir-plan',
  'noir-execute',
  'noir-verify',
  'noir-document',
];

function expectNoResidue(text: string) {
  for (const tok of FORBIDDEN_RESIDUE) expect(text).not.toContain(tok);
}

describe('builtin pack: shared hygiene', () => {
  it('every discovered skill validates and is WHEN-described', () => {
    for (const s of skills) {
      const res = validateSkill(s);
      expect(res.errors, `${s.name}: ${res.errors.join('; ')}`).toEqual([]);
      expect(looksLikeWhenDescription(s.frontmatter.description)).toBe(true);
      expectNoResidue(s.skillMd);
      for (const r of s.references) expectNoResidue(r.content);
    }
  });
});

describe('builtin pack: SDD lifecycle (T2)', () => {
  it('has all 7 lifecycle skills, each with a substantial body', () => {
    for (const name of FULL_LIFECYCLE) {
      const s = getOrFail(name);
      expect(bodyOf(s.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
    }
  });
});

const FULL_POWER = [
  'noir-brainstorm',
  'noir-debug',
  'noir-review',
  'noir-tdd',
  'noir-subagent',
  'noir-parallel',
  'noir-context',
];

describe('builtin pack: power skills (T3)', () => {
  it('has all 7 power skills, each with a substantial body', () => {
    for (const name of FULL_POWER) {
      const s = getOrFail(name);
      expect(bodyOf(s.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
    }
  });
});

const FULL_SESSION = ['noir-sync', 'noir-checkpoint', 'noir-explore'];

describe('builtin pack: session skills (T4)', () => {
  it('has all 3 full session skills, each with a substantial body', () => {
    for (const name of FULL_SESSION) {
      const s = getOrFail(name);
      expect(bodyOf(s.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
    }
  });
});

const FULL_MEMORY = ['noir-recall', 'noir-remember'];

describe('builtin pack: memory skills (S7)', () => {
  it('has both memory skills, each with a substantial body', () => {
    for (const name of FULL_MEMORY) {
      const s = getOrFail(name);
      expect(bodyOf(s.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
    }
  });
});

const STUBS = [
  'noir-wrap',
  'noir-commit',
  'noir-pr',
  'noir-branch',
  'noir-worktree',
  'noir-frontend',
  'noir-backend',
  'noir-security',
  'noir-test',
  'noir-doctor',
  'noir-skill-author',
  'noir-readme',
];

describe('builtin pack: stubs + totals (T5)', () => {
  it('has all 12 stubs, each marked as a stub', () => {
    for (const name of STUBS) {
      const s = getOrFail(name);
      expect(s.skillMd, `${name} missing stub marker`).toContain('> **Stub:**');
    }
  });
  it('pack total is 31 = 19 full + 12 stubs, all valid', () => {
    expect(skills.length).toBe(31);
    const stubCount = skills.filter((s) => s.skillMd.includes('> **Stub:**')).length;
    expect(stubCount).toBe(12);
    expect(skills.length - stubCount).toBe(19);
    for (const s of skills) expect(validateSkill(s).ok, `${s.name} invalid`).toBe(true);
  });
});
