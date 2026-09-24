// The skills quality gate's hygiene tier: the rules from hygiene.ts wired into
// `validateSkill` (fail tier blocks emission) and `lintSkill` (warn tier is
// advisory). A skill body is a markdown document, so its prose is checked as
// markdown and its fenced code blocks as source; the fixtures below exercise
// both, plus the exemption marker that lets a body state its own exemption.

import { describe, expect, it } from 'vitest';
import { bodyOf, lintSkill, validateSkill } from '../src/compiler.js';
import { HYGIENE_EXEMPT_MARKERS, MAX_COMMENT_BLOCK_LINES } from '../src/hygiene.js';
import { hygieneFindings } from '../src/quality.js';
import type { BuiltinSkill } from '../src/types.js';

/** A skill whose structure passes the gate, so any finding a test sees comes
 *  from the hygiene rules alone. The body is the only part that varies. */
function skillWithBody(body: string, name = 'noir-fixture'): BuiltinSkill {
  const description = 'Use when checking the hygiene gate — a defect in the body fails it.';
  const skillMd = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    'metadata:',
    '  category: meta',
    '  version: 1.0.0',
    '---',
    '',
    body,
    '',
  ].join('\n');
  return {
    name,
    dir: `/fake/skills/${name}`,
    skillMd,
    frontmatter: { name, description, metadata: { category: 'meta', version: '1.0.0' } },
    references: [],
  };
}

/** The canonical sections the structural gate requires, with no hygiene
 *  findings of their own — the clean base every fixture starts from. */
const BASE_BODY = [
  '## When to use',
  'When a test needs a body that carries a hygiene defect.',
  '',
  '## Procedure',
  '1. Read the body and note the defect.',
  '',
  '## Verification',
  'The gate reports the defect.',
].join('\n');

/** A run of `MAX_COMMENT_BLOCK_LINES` comment lines — the verbosity the warn
 *  tier flags when they sit inside one fenced code block. */
const commentBlock = (lines: number): string =>
  Array.from({ length: lines }, (_, i) => `// filler line ${i}`).join('\n');

/** The 1-based line `needle` sits on in `body`, so a test can pin the line a
 *  finding names without hand-counting fixture lines. */
const lineOf = (body: string, needle: string): number =>
  body.split('\n').findIndex((l) => l.includes(needle)) + 1;

/** Assembled rather than written out: the hygiene rules run over this
 *  repository's own sources, test files included, so a fixture line that opens
 *  with a decorative emoji would be a finding in this file. */
const PICTOGRAPH_LINE_EMOJI = '\u{1F3AF}';

/** The body the gate numbers its findings in: `bodyOf(skillMd)` carries the
 *  blank line that separates the frontmatter from the body, and the gate drops
 *  that one line so a finding names the line the author wrote in the body. */
const gatedBody = (body: string): string => bodyOf(skillWithBody(body).skillMd).replace(/^\n/, '');

/** The 1-based line `needle` sits on in the string the gate actually checks, so
 *  a line pin is counted the way the finding is — in the authored body. */
const gateLine = (body: string, needle: string): number => lineOf(gatedBody(body), needle);

describe('hygiene gate: fail tier blocks validation', () => {
  it('fails a skill whose body carries a decorative banner in its prose', () => {
    const banner = '# ============ Setup ============';
    const body = `${BASE_BODY}\n\n${banner}`;
    const res = validateSkill(skillWithBody(body));
    expect(res.ok).toBe(false);
    const hygieneErrors = res.errors.filter((e) => e.includes('decorative-banner'));
    expect(hygieneErrors).toHaveLength(1);
    // The message carries the rule id, the line, the rationale and the fix —
    // and the line is the banner's line in the BODY: the blank line that
    // separates the frontmatter from the body is not counted, so the number is
    // the one the author sees next to the text.
    expect(hygieneErrors[0]).toContain(`(line ${gateLine(body, banner)})`);
    expect(gateLine(body, banner)).toBe(lineOf(body, banner));
    expect(hygieneErrors[0]).toContain('machine output');
    expect(hygieneErrors[0]).toContain('Delete the divider');
  });

  it('fails a skill whose fenced code block carries a banner', () => {
    const fenced = ['```js', '// ============ Fetch users ============', '```'].join('\n');
    const res = validateSkill(skillWithBody(`${BASE_BODY}\n\n${fenced}`));
    expect(res.ok).toBe(false);
    expect(res.errors.filter((e) => e.includes('decorative-banner'))).toHaveLength(1);
  });
});

describe('hygiene gate: warn tier stays advisory', () => {
  it('warns on a long comment block inside a fenced code block', () => {
    const fenced = ['```js', commentBlock(MAX_COMMENT_BLOCK_LINES), '```'].join('\n');
    const body = `${BASE_BODY}\n\n${fenced}`;
    const res = lintSkill(skillWithBody(body));
    // A warn-tier finding never fails validation — it only joins the warnings.
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('long-comment-block'))).toBe(true);
    const warning = res.warnings.find((w) => w.includes('long-comment-block'));
    // The finding names the first line of the run, counted in the body.
    expect(warning).toContain(`(line ${gateLine(body, '// filler line 0')})`);
  });
});

describe('hygiene gate: the two tiers the lint command prints', () => {
  it('reports fail findings as errors and warn findings as warnings', () => {
    const body = [
      BASE_BODY,
      '',
      '# ============ Setup ============',
      '',
      '```js',
      commentBlock(MAX_COMMENT_BLOCK_LINES),
      '```',
    ].join('\n');
    const res = lintSkill(skillWithBody(body));
    // `noir skills lint` exits non-zero only for the errors array; the fail
    // tier lands there and the warn tier lands in warnings, which stay
    // advisory.
    expect(res.errors.some((e) => e.includes('decorative-banner'))).toBe(true);
    expect(res.warnings.some((w) => w.includes('long-comment-block'))).toBe(true);
  });

  it('leaves exit status untouched for a warn-only body (errors stay empty)', () => {
    const fenced = ['```js', commentBlock(MAX_COMMENT_BLOCK_LINES), '```'].join('\n');
    const res = lintSkill(skillWithBody(`${BASE_BODY}\n\n${fenced}`));
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('long-comment-block'))).toBe(true);
  });
});

describe('hygiene gate: the exemption marker', () => {
  it('produces no findings for a body that carries the exemption marker', () => {
    const defect = [
      BASE_BODY,
      '',
      '# ============ Setup ============',
      '',
      '```js',
      commentBlock(MAX_COMMENT_BLOCK_LINES),
      '```',
    ].join('\n');

    // Control: without the marker the same body produces both tiers, so the
    // assertions below prove the marker suppresses findings that really fire —
    // the fenced-code one included, which the document marker must cover even
    // though the code inside the fence is not markdown.
    const bare = validateSkill(skillWithBody(defect));
    expect(bare.errors.some((e) => e.includes('decorative-banner'))).toBe(true);
    expect(
      lintSkill(skillWithBody(defect)).warnings.some((w) => w.includes('long-comment-block')),
    ).toBe(true);

    const marked = skillWithBody([HYGIENE_EXEMPT_MARKERS.markdown, defect].join('\n'));
    const res = validateSkill(marked);
    // Neither tier fires: the banner is not an error, the comment block is not
    // a warning.
    expect(res.errors.filter((e) => e.includes('decorative-banner'))).toEqual([]);
    expect(res.ok).toBe(true);
    const linted = lintSkill(marked);
    expect(linted.warnings.filter((w) => w.includes('long-comment-block'))).toEqual([]);
  });
});

describe('hygiene gate: fenced blocks that document fences', () => {
  // A four-backtick block whose content shows a three-backtick example. The
  // shorter run is content: it neither closes the block nor opens one, so the
  // block stays a single code block. Reading the short run as a fence instead
  // would mask the narration below it as prose (losing the source-only finding)
  // and unmask the emoji heading as prose (inventing a markdown one).
  const NESTED = [
    '````text',
    '```',
    '// Step 1: load the configuration',
    `## ${PICTOGRAPH_LINE_EMOJI} Goals`,
    '````',
  ].join('\n');

  it('keeps a shorter fence run inside the block: source rules still fire', () => {
    const body = `${BASE_BODY}\n\n${NESTED}`;
    const res = validateSkill(skillWithBody(body));
    expect(res.ok).toBe(false);
    const narration = res.errors.filter((e) => e.includes('workflow-narration'));
    expect(narration).toHaveLength(1);
    // The finding names the narration line, counted in the body.
    expect(narration[0]).toContain(`(line ${gateLine(body, '// Step 1: load the configuration')})`);
  });

  it('checks the block as source only: no prose rule leaks onto its lines', () => {
    const body = `${BASE_BODY}\n\n${NESTED}`;
    // The fixture only proves anything while both defect lines are in it.
    expect(NESTED).toContain('// Step 1: load the configuration');
    expect(NESTED).toContain(PICTOGRAPH_LINE_EMOJI);
    // The emoji heading is inside the fence, so the markdown-only decorative
    // rule must not fire — the only finding is the source narration.
    expect(hygieneFindings(body).map((f) => f.id)).toEqual(['workflow-narration']);
  });

  it('treats an unclosed fence as source to the end of the body', () => {
    const body = [
      BASE_BODY,
      '',
      '```js',
      '// Step 1: load the configuration',
      `## ${PICTOGRAPH_LINE_EMOJI} Goals`,
    ].join('\n');
    expect(body).toContain(PICTOGRAPH_LINE_EMOJI);
    // Swallow-to-code: the unclosed block runs to the end of the body, so the
    // emoji heading is not prose and only the narration fires.
    expect(hygieneFindings(body).map((f) => f.id)).toEqual(['workflow-narration']);
  });
});
