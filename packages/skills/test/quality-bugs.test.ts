// The two latent bugs in the lint rules, pinned.
//
// `thin-body` and `no-example` both read `skill.skillMd` — the WHOLE file, YAML
// frontmatter included — even though each names the body as the thing it
// measures. That lets a long frontmatter (a padded `description`, extra
// metadata) stand in for a body the rule should have flagged, and lets a cue in
// the description stand in for a worked example the body never carried. The
// fixtures below are built so the two halves disagree: the frontmatter is long
// where the body is short, and the description carries the cue where the body
// carries none.

import { describe, expect, it } from 'vitest';
import { lintWarnings } from '../src/quality.js';
import type { BuiltinSkill } from '../src/types.js';

const DESCRIPTION = 'Use when checking the lint rules — flag a body that carries no cue.';

/** The description that smuggles the example cue into the frontmatter. The
 *  rule's cue list matches the word "example" and an "e.g." run, so the
 *  fixture carries both spellings: a description has no business standing in
 *  for a worked example in the body, in either form. */
const DESCRIPTION_WITH_CUE =
  'Use when a body lacks a worked example, e.g. a procedure with no snippet — flag the gap.';

/** Frontmatter lines: the canonical keys plus `padding` filler entries, so a
 *  test can make the frontmatter long without the body growing with it. */
function frontmatterLines(description: string, padding: number): string[] {
  return [
    'name: noir-fixture',
    `description: ${description}`,
    'metadata:',
    '  category: meta',
    '  version: 1.0.0',
    'license: MIT',
    'compatibility: claude',
    ...Array.from({ length: padding }, (_, i) => `extra-${i}: padding line`),
  ];
}

/** A skill assembled from the given frontmatter lines and body. `lintWarnings`
 *  reads only `skill.skillMd`, so the parsed frontmatter object is carried for
 *  shape, not re-derived from the markdown. */
function skillOf(frontmatter: string[], body: string): BuiltinSkill {
  const name = 'noir-fixture';
  return {
    name,
    dir: `/fake/skills/${name}`,
    skillMd: ['---', ...frontmatter, '---', '', body, ''].join('\n'),
    frontmatter: {
      name,
      description: DESCRIPTION,
      metadata: { category: 'meta', version: '1.0.0' },
    },
    references: [],
  };
}

/** A body with the required sections and a fenced example, but far under the
 *  20-line floor — short enough that only its length should be flagged. */
const SHORT_BODY = [
  '## When to use',
  'When the body is genuinely short.',
  '',
  '## Procedure',
  '1. Note the short body.',
  '',
  '## Verification',
  'The gate reports it.',
  '',
  '```js',
  "console.log('ok');",
  '```',
].join('\n');

/** A body that clears the 20-line floor while carrying no code fence, no
 *  "example" word, and no "e.g." — long enough to dodge `thin-body`, bare
 *  enough to draw `no-example`. */
const FULL_BODY = [
  '## When to use',
  'When a fixture needs a body that clears the thin floor.',
  '',
  '## Procedure',
  '1. Read the body and note the absence of a concrete sample.',
  '2. Record the gap.',
  '3. Report it to the author.',
  '',
  '## Verification',
  'The gate reports the missing sample.',
  '',
  '## Notes',
  '- A real skill would show a before and after pair here.',
  '- This fixture omits it on purpose.',
  '- The description carries the cue instead.',
  '- The gate must not be fooled by that cue.',
  '- It looks for a worked sample inside the body only.',
  '- This line keeps the body over the thin floor.',
  '- So the only finding is the missing sample.',
  '- One more line so the count is unambiguous.',
].join('\n');

/** `FULL_BODY` plus a fenced worked sample, so the body carries an example the
 *  description's cue must not be credited for. */
const FULL_BODY_WITH_EXAMPLE = [
  FULL_BODY,
  '',
  '```js',
  "console.log('worked sample');",
  '```',
].join('\n');

describe('thin-body measures the body, not the whole file', () => {
  it('warns for a short body under a long frontmatter', () => {
    // The whole file clears the old threshold by a wide margin (the frontmatter
    // alone is 27 lines), which is exactly how the rule used to be silenced.
    const s = skillOf(frontmatterLines(DESCRIPTION, 20), SHORT_BODY);
    expect(s.skillMd.split('\n').length).toBeGreaterThan(26);
    expect(lintWarnings(s).some((w) => w.startsWith('thin-body'))).toBe(true);
  });

  it('does not warn for a full body under a long frontmatter', () => {
    const s = skillOf(frontmatterLines(DESCRIPTION, 20), FULL_BODY);
    expect(lintWarnings(s).some((w) => w.startsWith('thin-body'))).toBe(false);
  });
});

describe('no-example looks for the example in the body, not the frontmatter', () => {
  it('warns when only the description carries the cue', () => {
    // The fixture only proves anything while the cue sits in the frontmatter
    // and nowhere in the body.
    expect(DESCRIPTION_WITH_CUE).toContain('example');
    expect(DESCRIPTION_WITH_CUE).toContain('e.g.');
    expect(FULL_BODY).not.toContain('example');
    expect(FULL_BODY).not.toContain('e.g.');

    const s = skillOf(frontmatterLines(DESCRIPTION_WITH_CUE, 0), FULL_BODY);
    expect(lintWarnings(s).some((w) => w.startsWith('no-example'))).toBe(true);
  });

  it('does not warn when the body carries a worked sample', () => {
    const s = skillOf(frontmatterLines(DESCRIPTION_WITH_CUE, 0), FULL_BODY_WITH_EXAMPLE);
    expect(lintWarnings(s).some((w) => w.startsWith('no-example'))).toBe(false);
  });
});
