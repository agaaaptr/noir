// Offline behavioral-eval harness for the skill pack.
//
// Skills are declared as `evals/**/evals.json` per the agentskills.io format
// (`{skill_name, evals:[{id, prompt, expected_output, assertions?}]}`). The
// harness loads every suite and runs OFFLINE assertions only — `contains`,
// `not-contains`, `regex`, `length-gte` — no LLM, no network, so it runs in
// `pnpm test` (the project's offline/free constraint). This is the executable
// that turns the JSON declaration into a vitest suite (see test/evals.test.ts).
//
// The evals are deliberately simple: they assert that a skill's PROMPT → a
// simulated agent answer satisfies structural expectations. They are NOT
// LLM-judge evals (not implemented yet); they are the CI-safe
// baseline that catches regressions in the skill's core directives.
//
// Assertions must be able to run against a CANDIDATE answer (what a model or
// a stub standing in for one actually produced), not only against the
// self-declared `expected_output` — otherwise a suite can never fail for the
// right reason. `evaluateSuite` therefore accepts an optional candidate-output
// source. Passing no source keeps asserting `expected_output`, so suites that
// predate candidate output work unchanged; passing a source makes an eval it
// has no entry for a failure, so an unrecorded answer is never scored a pass.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A single offline assertion on the produced output. */
export type EvalAssertion =
  | { type: 'contains'; value: string }
  | { type: 'not-contains'; value: string }
  | { type: 'regex'; value: string }
  | { type: 'length-gte'; value: number };

/** One eval case: a prompt + the expected directive the skill must produce. */
export interface SkillEval {
  id: string;
  prompt: string;
  expected_output: string;
  assertions?: EvalAssertion[];
}

/** A suite = one skill's evals (the `evals.json` shape). */
export interface EvalSuite {
  skill_name: string;
  evals: SkillEval[];
}

/**
 * Candidate answers keyed by eval id — what a model (or a stub standing in for
 * one) actually produced. An id present here is the text the assertions run
 * against. An id absent is a failure for that eval: the run recorded no answer,
 * and asserting the golden `expected_output` instead would report a pass the
 * harness cannot vouch for. Pass no source at all to assert `expected_output`,
 * which is how suites that predate candidate output keep working.
 */
export type CandidateOutputs = Record<string, string>;

/** Validate an assertion's shape (fail-fast on a malformed evals.json). */
function parseAssertion(a: unknown): EvalAssertion {
  if (typeof a !== 'object' || a === null) throw new Error('assertion must be an object');
  const { type, value } = a as { type?: unknown; value?: unknown };
  switch (type) {
    case 'contains':
    case 'not-contains':
    case 'regex':
      if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`assertion '${String(type)}' requires a non-empty string value`);
      }
      return { type, value } as EvalAssertion;
    case 'length-gte':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error("assertion 'length-gte' requires a finite number value");
      }
      return { type, value } as EvalAssertion;
    default:
      throw new Error(`unknown assertion type '${String(type)}'`);
  }
}

/** Parse + validate a raw `evals.json` payload. Throws on malformed shape. */
export function parseEvalSuite(raw: unknown): EvalSuite {
  if (typeof raw !== 'object' || raw === null) throw new Error('evals.json must be an object');
  const { skill_name, evals } = raw as { skill_name?: unknown; evals?: unknown };
  if (typeof skill_name !== 'string' || skill_name.length === 0) {
    throw new Error('evals.json requires a non-empty string `skill_name`');
  }
  if (!Array.isArray(evals) || evals.length === 0) {
    throw new Error(`evals.json for ${skill_name} requires a non-empty 'evals' array`);
  }
  const parsed: SkillEval[] = evals.map((e, i) => {
    if (typeof e !== 'object' || e === null) throw new Error(`eval[${i}] must be an object`);
    const { id, prompt, expected_output, assertions } = e as {
      id?: unknown;
      prompt?: unknown;
      expected_output?: unknown;
      assertions?: unknown;
    };
    if (typeof id !== 'string' || id.length === 0)
      throw new Error(`eval[${i}] requires a string id`);
    if (typeof prompt !== 'string' || prompt.length === 0) {
      throw new Error(`eval ${id} requires a string prompt`);
    }
    if (typeof expected_output !== 'string') {
      throw new Error(`eval ${id} requires a string expected_output`);
    }
    return {
      id,
      prompt,
      expected_output,
      assertions: Array.isArray(assertions) ? assertions.map(parseAssertion) : undefined,
    };
  });
  return { skill_name, evals: parsed };
}

/** Run a list of assertions against `output`. Returns pass + per-assertion failures. */
export function runAssertions(
  output: string,
  assertions: EvalAssertion[],
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const a of assertions) {
    switch (a.type) {
      case 'contains':
        if (!output.includes(a.value)) failures.push(`expected to contain "${a.value}"`);
        break;
      case 'not-contains':
        if (output.includes(a.value)) failures.push(`expected NOT to contain "${a.value}"`);
        break;
      case 'regex':
        if (!new RegExp(a.value, 'i').test(output)) failures.push(`expected to match /${a.value}/`);
        break;
      case 'length-gte':
        if (output.length < a.value)
          failures.push(`expected length >= ${a.value} (got ${output.length})`);
        break;
    }
  }
  return { pass: failures.length === 0, failures };
}

// Package root (evals/ is a sibling of src/): resolve the evals dir the same
// way discover.ts resolves builtin/. Works under vitest (src) + built (dist).
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = dirname(HERE);
export const EVALS_DIR = join(PKG_ROOT, 'evals');

/**
 * Load every eval suite under `dir` (default the shipped `evals/` dir — each
 * subdir carries an `evals.json`). Skips non-`.json` files and missing dirs
 * (no evals = no-op). Fail-fast on a malformed suite (a broken evals.json is a
 * bug, not a skip).
 */
export function loadEvalSuites(dir: string = EVALS_DIR): EvalSuite[] {
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return []; // no evals/ dir (or unreadable) = no suites shipped
  }
  const suites: EvalSuite[] = [];
  for (const name of entries) {
    const file = join(dir, name, 'evals.json');
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown;
      suites.push(parseEvalSuite(raw));
    } catch (err) {
      // Missing evals.json in a subdir is fine (it may be a scratch dir); a
      // malformed one is not. Distinguish by existence.
      try {
        readFileSync(file, 'utf8');
        throw err; // exists but malformed → rethrow
      } catch (re) {
        if (re === err) throw err;
        // ENOENT → skip silently.
      }
    }
  }
  return suites;
}

/** Evaluate one suite: for each eval, check its assertions against the
 *  candidate output supplied for that eval. With no candidate source at all,
 *  each eval is checked against `expected_output` (the directive the skill
 *  should produce); with a source that omits an eval, that eval fails as
 *  unrecorded. Returns pass/fail per eval with the assertion failures. This is
 *  the offline core the vitest runner drives. */
export function evaluateSuite(
  suite: EvalSuite,
  candidates?: CandidateOutputs,
): Array<{ id: string; pass: boolean; failures: string[] }> {
  return suite.evals.map((e) => {
    // A supplied candidate source that has no entry for this eval means the
    // run could not record an answer (a misspelled id, or a model call that
    // never happened). Scoring the golden `expected_output` here would report
    // the very pass this harness exists to prevent, so a missing entry is a
    // failure — but only when a source was supplied at all. With no source, a
    // suite that predates candidate output keeps asserting its declared
    // directive (backward compatible).
    if (candidates && !(e.id in candidates)) {
      return { id: e.id, pass: false, failures: [`no candidate output for eval "${e.id}"`] };
    }
    const output = candidates ? (candidates[e.id] ?? e.expected_output) : e.expected_output;
    return {
      id: e.id,
      pass: e.assertions ? runAssertions(output, e.assertions).pass : true,
      failures: e.assertions ? runAssertions(output, e.assertions).failures : [],
    };
  });
}
