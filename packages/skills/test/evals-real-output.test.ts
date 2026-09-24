// The eval harness must be able to fail for the RIGHT reason: because the
// candidate answer broke a rule, not merely because `expected_output` was
// written to satisfy its own assertions. These tests feed a candidate output
// (a stand-in string for what a model produced — no LLM, no network) and check
// that every assertion type is decided by it.

import { describe, expect, it } from 'vitest';
import { type EvalAssertion, evaluateSuite, loadEvalSuites, parseEvalSuite } from '../src/evals.js';

/** A one-case suite whose `expected_output` satisfies its own assertions, so
 *  the self-referential path always passes; only the candidate decides. */
function oneCase(assertions: EvalAssertion[]) {
  return parseEvalSuite({
    skill_name: 'noir-code-hygiene',
    evals: [
      {
        id: 'case',
        prompt: 'Write a comment.',
        expected_output: 'Write a failing test first.',
        assertions,
      },
    ],
  });
}

describe('evaluateSuite() — the candidate output decides the result', () => {
  it('fails a case whose expected_output matches but whose candidate violates the rule', () => {
    const suite = oneCase([{ type: 'not-contains', value: 'As an AI' }]);
    const slop = 'Sure! As an AI language model, here is your comment.';

    // With no candidate, the assertions run against expected_output and pass —
    // the harness looks green even though the real answer is slop.
    expect(evaluateSuite(suite)[0]?.pass).toBe(true);

    // With the candidate, the same case fails for the right reason.
    const [result] = evaluateSuite(suite, { case: slop });
    expect(result?.pass).toBe(false);
    expect(result?.failures).toEqual(['expected NOT to contain "As an AI"']);
  });

  it('decides each of the four assertion types from the candidate output', () => {
    const cases: Array<{ assertion: EvalAssertion; clean: string; slop: string }> = [
      {
        assertion: { type: 'contains', value: 'failing test' },
        clean: 'Write a failing test first.',
        slop: 'Implement it and move on.',
      },
      {
        assertion: { type: 'not-contains', value: 'As an AI' },
        clean: 'Return the cached config.',
        slop: 'As an AI language model, I cannot.',
      },
      {
        assertion: { type: 'regex', value: 'reproduce|confirm' },
        clean: 'Reproduce it first.',
        slop: 'Patch the symptom and ship.',
      },
      {
        assertion: { type: 'length-gte', value: 20 },
        clean: 'A comment that says something useful.',
        slop: 'ok.',
      },
    ];
    for (const { assertion, clean, slop } of cases) {
      const suite = oneCase([assertion]);
      expect(
        evaluateSuite(suite, { case: clean })[0]?.pass,
        `clean candidate should pass a ${assertion.type} assertion`,
      ).toBe(true);
      expect(
        evaluateSuite(suite, { case: slop })[0]?.pass,
        `slop candidate should fail a ${assertion.type} assertion`,
      ).toBe(false);
    }
  });

  it('fails an eval the candidate source has no entry for, rather than scoring the golden output', () => {
    const suite = oneCase([{ type: 'contains', value: 'failing test' }]);
    for (const candidates of [{ other: 'irrelevant' }, {}]) {
      const [missing] = evaluateSuite(suite, candidates);
      expect(missing?.pass).toBe(false);
      expect(missing?.failures).toEqual(['no candidate output for eval "case"']);
    }
  });

  it('keeps asserting expected_output when no candidate source is given (backward compatible)', () => {
    const suite = oneCase([{ type: 'contains', value: 'failing test' }]);
    expect(evaluateSuite(suite)[0]?.pass).toBe(true);
  });
});

describe('shipped noir-code-hygiene suite — fails on slop, passes on clean', () => {
  const hygieneSuite = () => {
    const suite = loadEvalSuites().find((s) => s.skill_name === 'noir-code-hygiene');
    if (!suite) throw new Error('noir-code-hygiene eval suite not shipped');
    return suite;
  };

  // A candidate that trips the suite's rules: a machine preamble, an emoji
  // flourish, a decorative divider and workflow narration.
  const SLOP: Record<string, string> = {
    'no-machine-preamble':
      'Sure! As an AI language model, I can help with that. Step 1: fetch the user.',
    'no-decorative-flourish':
      '✅ ------- Parse the config once. 🚀 Step 1: cache it so it is fast.',
  };

  // A candidate that says the same things without the noise.
  const CLEAN: Record<string, string> = {
    'no-machine-preamble':
      'Return the matching user, or null when the id is not found. Callers rely on null to mean not-found.',
    'no-decorative-flourish':
      'Parse the config once at startup and cache it, because every request reads it.',
  };

  // The exact failures each slop candidate must produce, in assertion order.
  // A rule that silently stopped firing would shrink its list and fail here.
  const SLOP_FAILURES: Record<string, string[]> = {
    'no-machine-preamble': [
      'expected NOT to contain "As an AI"',
      'expected NOT to contain "Sure"',
      'expected to contain "null"',
      'expected to match /not[- ]?found|no such user/',
    ],
    'no-decorative-flourish': [
      'expected NOT to contain "✅"',
      'expected NOT to contain "🚀"',
      'expected NOT to contain "----"',
      'expected NOT to contain "Step 1"',
      'expected to match /because|since|so that/',
    ],
  };

  it('ships the hygiene suite and passes it against a clean candidate', () => {
    const results = evaluateSuite(hygieneSuite(), CLEAN);
    for (const r of results) expect(r.pass, r.id).toBe(true);
  });

  it('fails every hygiene eval against the slop-laden candidate, rule by rule', () => {
    const results = evaluateSuite(hygieneSuite(), SLOP);
    expect(results.map((r) => r.id).sort()).toEqual(Object.keys(SLOP_FAILURES).sort());
    for (const r of results) {
      expect(r.pass, r.id).toBe(false);
      expect(r.failures, r.id).toEqual(SLOP_FAILURES[r.id]);
    }
  });

  it('passes against its own expected_output with no candidate source (backward compatible)', () => {
    const results = evaluateSuite(hygieneSuite());
    for (const r of results) expect(r.pass, r.id).toBe(true);
  });
});
