import { describe, expect, it } from 'vitest';
import {
  evaluateSuite,
  loadEvalSuites,
  parseEvalSuite,
  runAssertions,
} from '../src/evals.js';

describe('runAssertions() — offline assertion engine', () => {
  it('passes when all assertions hold', () => {
    const r = runAssertions('Write a failing test first, then implement.', [
      { type: 'contains', value: 'failing test' },
      { type: 'not-contains', value: 'implementation first' },
      { type: 'regex', value: 'failing test' },
      { type: 'length-gte', value: 10 },
    ]);
    expect(r.pass).toBe(true);
    expect(r.failures).toEqual([]);
  });

  it('reports each failed assertion', () => {
    const r = runAssertions('short', [
      { type: 'contains', value: 'missing phrase' },
      { type: 'length-gte', value: 100 },
    ]);
    expect(r.pass).toBe(false);
    expect(r.failures.length).toBe(2);
  });

  it('rejects an unknown assertion type via parseEvalSuite (the shape validator)', () => {
    // runAssertions is the hot loop and deliberately does NOT re-validate types
    // (assertions arrive already-parsed); parseEvalSuite is the shape gate.
    expect(() =>
      parseEvalSuite({
        skill_name: 'noir-x',
        evals: [{ id: 'e', prompt: 'p', expected_output: 'o', assertions: [{ type: 'bogus', value: 'x' }] }],
      }),
    ).toThrow(/unknown assertion type/);
  });
});

describe('parseEvalSuite() — evals.json shape validation', () => {
  it('parses a valid suite', () => {
    const s = parseEvalSuite({
      skill_name: 'noir-x',
      evals: [{ id: 'e1', prompt: 'p', expected_output: 'o', assertions: [{ type: 'contains', value: 'o' }] }],
    });
    expect(s.skill_name).toBe('noir-x');
    expect(s.evals[0]?.id).toBe('e1');
  });

  it('rejects a suite without skill_name or empty evals', () => {
    expect(() => parseEvalSuite({ evals: [] })).toThrow(/skill_name/);
    expect(() => parseEvalSuite({ skill_name: 'x', evals: [] })).toThrow(/evals/);
  });

  it('rejects a malformed eval entry', () => {
    expect(() =>
      parseEvalSuite({ skill_name: 'x', evals: [{ id: 'e', prompt: 'p' }] }),
    ).toThrow(/expected_output/);
  });
});

describe('shipped evals — offline suites in the pack', () => {
  it('loads ≥2 suites (noir-tdd + noir-debug) from the shipped evals dir', () => {
    const suites = loadEvalSuites();
    expect(suites.length).toBeGreaterThanOrEqual(2);
    const names = suites.map((s) => s.skill_name);
    expect(names).toContain('noir-tdd');
    expect(names).toContain('noir-debug');
  });

  it('every shipped eval passes its own assertions (offline, no LLM)', () => {
    const suites = loadEvalSuites();
    for (const suite of suites) {
      const results = evaluateSuite(suite);
      for (const r of results) {
        expect(r.pass, `${suite.skill_name}/${r.id}: ${r.failures.join('; ')}`).toBe(true);
      }
    }
  });
});
