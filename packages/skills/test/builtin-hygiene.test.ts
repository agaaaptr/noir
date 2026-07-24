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
      const s = byName.get(name);
      expect(s, `missing ${name}`).toBeDefined();
      // `s` is guaranteed defined by the assertion above; use optional chain to satisfy noNonNullAssertion.
      expect(bodyOf(s?.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
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
];

describe('builtin pack: power skills (T3)', () => {
  it('has all 6 power skills, each with a substantial body', () => {
    for (const name of FULL_POWER) {
      const s = byName.get(name);
      expect(s, `missing ${name}`).toBeDefined();
      // `s` is guaranteed defined by the assertion above; use optional chain to satisfy noNonNullAssertion.
      expect(bodyOf(s?.skillMd).length, `${name} body too short`).toBeGreaterThan(300);
    }
  });
});
