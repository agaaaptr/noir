// The `noir-code-hygiene` skill: the pack's own guidance on output hygiene.
//
// The skill teaches the rules the quality gate enforces, so its body has to
// pass that gate itself — a guidance file its own rules would reject teaches
// the wrong lesson, and a reader who notices learns to distrust both. These
// assertions therefore run the REAL loader and the REAL gate (validateSkill,
// lintSkill, hygieneFindings) rather than a re-implementation of either, so the
// file cannot drift away from the rules it documents.

import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  discoverBuiltin,
  lintSkill,
  looksLikeWhenDescription,
  validateSkill,
} from '../src/compiler.js';
import { HYGIENE_EXEMPT_MARKERS } from '../src/hygiene.js';
import { hygieneFindings, isWhatWhenDescription } from '../src/quality.js';

const skill = discoverBuiltin().find((s) => s.name === 'noir-code-hygiene');

/** The skill under test — thrown for rather than asserted, so a missing skill
 *  fails with the reason instead of leaving every later assertion optional. */
function loaded() {
  if (!skill) throw new Error('the shipped pack has no noir-code-hygiene skill');
  return skill;
}

/** The skill's body: frontmatter stripped, exactly as the gate reads it. */
function body(): string {
  return bodyOf(loaded().skillMd);
}

/** The nine defects the guidance must cover, each identified by a word its
 *  section heading carries. */
const REQUIRED_DEFECTS = [
  'separator', // decorative separators and banners
  'restating', // restating the obvious
  'narration', // workflow narration
  'empty label', // empty labels
  'stale', // stale comments
  'emoji', // decorative icons and emoji
  'verbosity', // verbosity
  'jargon', // internal jargon
  'assumption', // unstated assumptions
];

/** The skill's defect entries: each `### ` section of the guidance. */
function entrySections(): string[] {
  return body().split(/^### /m).slice(1);
}

describe('noir-code-hygiene: it passes the gate it documents', () => {
  it('validates with no errors through the real loader', () => {
    const res = validateSkill(loaded());
    expect(res.errors, res.errors.join('; ')).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('carries no lint warnings — the advisory tier included', () => {
    // The warn tier is what a body gets for a long comment block or a marker
    // nobody can act on; guidance about those defects cannot carry them.
    expect(lintSkill(loaded()).warnings).toEqual([]);
  });

  it('is clean under the hygiene rules, prose and fenced code alike', () => {
    // `hygieneFindings` is the gate's own path: it splits the body into the
    // prose and the fenced blocks, checks each as the kind of text it is, and
    // returns the findings in reading order.
    expect(hygieneFindings(body())).toEqual([]);
  });

  it('states its own exemption for nothing — no exemption marker in the body', () => {
    // A body that carried the marker would be exempt from every rule, which
    // would make the cleanliness assertions above pass vacuously. The guidance
    // names the marker without wearing it.
    const markerLines = body()
      .split('\n')
      .filter((line) => line.trim() === HYGIENE_EXEMPT_MARKERS.markdown);
    expect(markerLines).toEqual([]);
  });

  it('describes itself with WHAT + WHEN', () => {
    const { description } = loaded().frontmatter;
    expect(looksLikeWhenDescription(description)).toBe(true);
    expect(isWhatWhenDescription(description)).toBe(true);
    // The trigger has to name the subject, or the host cannot route to it.
    expect(description.toLowerCase()).toContain('comment');
  });
});

describe('noir-code-hygiene: the guidance itself', () => {
  it('carries a worked before/after pair', () => {
    const text = body();
    expect(text).toMatch(/^Before:$/m);
    expect(text).toMatch(/^After:$/m);
    // Two labelled snippets means four fence lines.
    expect(text.match(/^```/gm) ?? []).toHaveLength(4);
  });

  it('covers every required defect in Tell / Why / Fix form', () => {
    const sections = entrySections();
    expect(sections.length).toBeGreaterThanOrEqual(REQUIRED_DEFECTS.length);
    for (const defect of REQUIRED_DEFECTS) {
      const section = sections.find((s) => s.toLowerCase().includes(defect));
      expect(section, `no entry covers "${defect}"`).toBeDefined();
      // Every entry answers the same three questions, so a reader can scan one
      // shape down the page instead of re-reading prose.
      expect(section, `"${defect}" has no Tell`).toContain('**Tell:**');
      expect(section, `"${defect}" has no Why`).toContain('**Why:**');
      expect(section, `"${defect}" has no Fix`).toContain('**Fix:**');
    }
  });

  it('names the surfaces that enforce the rules, so guidance and gate agree', () => {
    const text = body();
    expect(text).toContain('noir skills lint');
    expect(text).toContain('noir doctor');
    // The exemption marker is part of the contract a reader has to know about.
    expect(text).toContain('noir-hygiene: exempt');
  });

  it('ships one level of references, carrying more worked examples', () => {
    const refs = loaded().references;
    expect(refs.map((r) => r.name)).toEqual(['examples.md']);
    const examples = refs[0]?.content ?? '';
    expect(examples.length).toBeGreaterThan(500);
    expect(examples).toMatch(/^Before:$/m);
    expect(examples).toMatch(/^After:$/m);
  });
});
