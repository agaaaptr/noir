// The skills quality gate's hygiene tier: the rules from hygiene.ts wired into
// `validateSkill` (fail tier blocks emission) and `lintSkill` (warn tier is
// advisory). A skill body is a markdown document, so its prose is checked as
// markdown and its fenced code blocks as source; the fixtures below exercise
// both, plus the exemption marker that lets a body state its own exemption.

import { describe, expect, it } from 'vitest';
import { lintSkill, validateSkill } from '../src/compiler.js';
import { HYGIENE_EXEMPT_MARKERS, MAX_COMMENT_BLOCK_LINES } from '../src/hygiene.js';
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

describe('hygiene gate: fail tier blocks validation', () => {
  it('fails a skill whose body carries a decorative banner in its prose', () => {
    const res = validateSkill(skillWithBody(`${BASE_BODY}\n\n# ============ Setup ============`));
    expect(res.ok).toBe(false);
    const hygieneErrors = res.errors.filter((e) => e.includes('decorative-banner'));
    expect(hygieneErrors).toHaveLength(1);
    // The message carries the rule id, the line, the rationale and the fix.
    expect(hygieneErrors[0]).toMatch(/decorative-banner \(line \d+\)/);
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
    const res = lintSkill(skillWithBody(`${BASE_BODY}\n\n${fenced}`));
    // A warn-tier finding never fails validation — it only joins the warnings.
    expect(res.errors).toEqual([]);
    expect(res.warnings.some((w) => w.includes('long-comment-block'))).toBe(true);
    const warning = res.warnings.find((w) => w.includes('long-comment-block'));
    expect(warning).toMatch(/long-comment-block \(line \d+\)/);
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
