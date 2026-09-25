import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkHygiene,
  HYGIENE_EXEMPT_MARKERS,
  HYGIENE_RULES,
  type HygieneKind,
  type HygieneRule,
  MAX_COMMENT_BLOCK_LINES,
} from '../src/hygiene.js';
import { FORBIDDEN_RESIDUE, RESIDUE_RULES } from '../src/residue.js';

// Fixtures are assembled rather than written out so this file does not itself
// carry a banner, a narration comment or a decorative emoji: the hygiene rules
// run over this repository's own sources, test files included. The residue
// fixtures are the exception — they name the forbidden tokens on purpose, to
// assert that those tokens still fire — so this gate fixture carries the
// exemption marker rather than keeping the tokens out of its own text.
// noir-hygiene: exempt

/** A one-line comment holding `body`, exactly as a person would write it. */
const comment = (body: string): string => `// ${body}`;

/** A divider banner around `label`: the decorative shape the banner rule is
 *  meant to catch. */
const banner = (label: string): string => comment(`${'='.repeat(12)} ${label} ${'='.repeat(12)}`);

/** The contents of a file in this repository, relative to this test file. */
const readSource = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

/** `source` with the exemption marker line removed, so a check that should
 *  prove cleanliness still sees the lines that matter. */
function withoutMarker(source: string, kind: HygieneKind): string {
  return source
    .split('\n')
    .filter((line) => line.trim() !== HYGIENE_EXEMPT_MARKERS[kind])
    .join('\n');
}

function ids(text: string, kind: HygieneKind = 'code'): string[] {
  return checkHygiene(text, kind).map((f) => f.id);
}

function ruleOrFail(id: string): HygieneRule {
  const rule = HYGIENE_RULES.find((r) => r.id === id);
  if (!rule) throw new Error(`no hygiene rule with id ${id}`);
  return rule;
}

describe('the rule table', () => {
  it('declares every rule with an id, a tier, a pattern and readable guidance', () => {
    expect(HYGIENE_RULES.length).toBeGreaterThanOrEqual(4);
    for (const rule of HYGIENE_RULES) {
      expect(rule.id, `${rule.id} is not a stable id`).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(['fail', 'warn'], `${rule.id} has no tier`).toContain(rule.tier);
      expect(rule.pattern, `${rule.id} has no pattern`).toBeInstanceOf(RegExp);
      expect(rule.rationale.length, `${rule.id} explains nothing`).toBeGreaterThan(30);
      expect(rule.fix.length, `${rule.id} offers no fix`).toBeGreaterThan(30);
      expect(['code', 'markdown', 'both']).toContain(rule.appliesTo);
    }
  });

  it('gives every rule a distinct id and leaves the global flag off', () => {
    const ruleIds = HYGIENE_RULES.map((r) => r.id);
    expect(new Set(ruleIds).size).toBe(ruleIds.length);
    // A shared pattern carrying /g would hold lastIndex between calls, which
    // would make the checker's results depend on how often it had been called.
    for (const rule of HYGIENE_RULES) expect(rule.pattern.flags).not.toContain('g');
  });

  it('keeps every forbidden residue token in a fail-tier rule of its own', () => {
    expect(RESIDUE_RULES.length).toBe(FORBIDDEN_RESIDUE.length);
    FORBIDDEN_RESIDUE.forEach((token, index) => {
      const own = RESIDUE_RULES[index];
      expect(own?.tier, `${token} has no fail-tier rule`).toBe('fail');
      expect(own?.pattern.test(token), `the rule for ${token} does not match it`).toBe(true);
      expect(own?.appliesTo, `${token} is not checked in both kinds`).toBe('both');
      expect(HYGIENE_RULES.some((r) => r.id === own?.id)).toBe(true);
    });
  });

  it('does not tier the residue tokens twice', () => {
    for (const token of FORBIDDEN_RESIDUE) {
      for (const rule of HYGIENE_RULES.filter((r) => r.tier === 'warn')) {
        expect(rule.pattern.test(token), `${rule.id} also flags ${token}`).toBe(false);
      }
    }
  });

  it('is clean under its own rules', () => {
    // The rule source carries the exemption marker because it defines the
    // rules, so the marker line is removed first: what is asserted here is
    // that every other line passes the rules the file declares.
    const source = withoutMarker(readSource('../src/hygiene.ts'), 'code');
    expect(checkHygiene(source, 'code')).toEqual([]);
  });
});

describe('fail tier: decorative banners', () => {
  it('flags a run of punctuation around a label, on the line it sits on', () => {
    const source = ['const cache = new Map();', banner('Fetch users'), 'export {}'].join('\n');
    const findings = checkHygiene(source, 'code');
    expect(findings.map((f) => f.id)).toEqual(['decorative-banner']);
    expect(findings[0]?.tier).toBe('fail');
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.text).toBe(banner('Fetch users'));
  });

  it('flags the same divider in a block comment, a hash comment and a document heading', () => {
    expect(ids(`/* ${'-'.repeat(8)} helpers ${'-'.repeat(8)} */`)).toContain('decorative-banner');
    expect(ids(`# ${'='.repeat(10)} Config ${'='.repeat(10)}`)).toContain('decorative-banner');
    expect(ids(banner('Setup'), 'markdown')).toContain('decorative-banner');
  });
});

describe('fail tier: workflow narration', () => {
  const narration = [
    'Step 1: load the configuration',
    'Step 2: validate the payload',
    'First, read the file',
    'Next, apply the patch',
    'Finally, write the result',
  ];

  it.each(narration)('flags %j', (body) => {
    expect(ids(comment(body))).toContain('workflow-narration');
  });

  it('flags narration on a block-comment line and reports that line', () => {
    const source = ['/*', ` * ${'Step 3: retry once'}`, ' */'].join('\n');
    const findings = checkHygiene(source, 'code');
    expect(findings.map((f) => f.id)).toEqual(['workflow-narration']);
    expect(findings[0]?.line).toBe(2);
  });

  it('leaves an ordinal that describes a position rather than an order of work', () => {
    expect(checkHygiene(comment('first, which is all these assertions need'), 'code')).toEqual([]);
  });

  it('leaves an ordinal that states the reason the step exists', () => {
    expect(
      checkHygiene(comment('First, init to establish the project id so sync can read it'), 'code'),
    ).toEqual([]);
  });
});

describe('fail tier: decorative emoji', () => {
  it('flags an emoji anywhere in a code comment', () => {
    expect(ids(comment('✅ Done'))).toContain('decorative-emoji-comment');
    expect(ids(comment('added retry with backoff 🚀'))).toContain('decorative-emoji-comment');
  });

  it('flags a pictograph that opens a comment even outside the known set', () => {
    expect(ids(comment('🎯 replace the old parser'))).toContain('decorative-pictograph-comment');
  });

  it('flags a document line that opens with a decorative emoji', () => {
    expect(ids('## 🎯 Goals', 'markdown')).toContain('decorative-emoji-doc');
    expect(ids('- ✅ Ship the migration', 'markdown')).toContain('decorative-emoji-doc');
  });

  it('leaves a comment that quotes the glyph it describes', () => {
    const themeBadgeComment =
      '//   - `badge()` ALWAYS returns SYMBOL + TEXT LABEL (e.g. `⚠ warn`), so NO_COLOR';
    expect(checkHygiene(themeBadgeComment, 'code')).toEqual([]);
    expect(checkHygiene(comment('@example badge(\'warn\') → yellow "⚠ degraded"'), 'code')).toEqual(
      [],
    );
  });

  it('still flags a glyph the comment is using rather than quoting', () => {
    expect(ids(comment('see ⚠ for the warning path'))).toContain('decorative-emoji-comment');
  });
});

describe('fail tier: forbidden residue', () => {
  it('flags every residue token and reports the line it sits on', () => {
    for (const token of FORBIDDEN_RESIDUE) {
      const findings = checkHygiene(`The notes mention ${token} in passing.`, 'markdown');
      expect(findings.length, `nothing flags ${token}`).toBeGreaterThanOrEqual(1);
      expect(findings[0]?.tier, `${token} is not fail-tier`).toBe('fail');
      expect(findings[0]?.text).toContain(token);
      expect(findings[0]?.line).toBe(1);
    }
  });

  it('flags a residue token in code as well as in prose', () => {
    const token = FORBIDDEN_RESIDUE[0] ?? '';
    expect(ids(`const stale = '${token}';`)).toHaveLength(1);
  });

  it("leaves the name of this repository's own workflow engine alone", () => {
    const fixture = "const dir = mkdtempSync(join(tmpdir(), 'noir-workflow-engine-'));";
    expect(checkHygiene(fixture, 'code')).toEqual([]);
  });

  it('still flags a longer compound that names the removed plugin', () => {
    expect(ids('see plugins/noir-workflow/ for the old mode')).toContain(
      'residue-plugins-noir-workflow',
    );
    expect(ids('the noir-workflow.mode flag is gone')).toContain('residue-noir-workflow-mode');
  });
});

describe('fail tier: another script, or an invisible character', () => {
  it('flags a character from another writing system', () => {
    expect(ids(comment('return the 汉 name'))).toContain('no-irregular-script');
    expect(ids(comment('Привет is Russian for hello'))).toContain('no-irregular-script');
    expect(ids('const label = "ＡＢＣ";')).toContain('no-irregular-script');
  });

  it('flags a code point that draws nothing, or one a bad decode produced', () => {
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const byteOrderMark = String.fromCharCode(0xfeff);
    const replacement = String.fromCharCode(0xfffd);
    expect(ids(`const sep = 'a${zeroWidthSpace}b';`)).toContain('no-irregular-script');
    expect(ids(`const bom = '${byteOrderMark}';`)).toContain('no-irregular-script');
    expect(ids(`const broken = '${replacement}';`)).toContain('no-irregular-script');
  });

  it('reports the line the character sits on, in prose as well as in code', () => {
    const findings = checkHygiene(['# Title', '', 'the 汉 character'].join('\n'), 'markdown');
    expect(findings.map((f) => [f.line, f.id])).toEqual([[3, 'no-irregular-script']]);
    expect(findings[0]?.tier).toBe('fail');
  });

  it('leaves the typography, the symbols and the badges this project writes alone', () => {
    const typography =
      'Diátaxis and Büttcher — an en dash – an ellipsis … a section § a middle dot · a degree ° “quoted” ‘single’';
    expect(checkHygiene(typography, 'markdown')).toEqual([]);
    expect(checkHygiene(typography, 'code')).toEqual([]);

    const symbols = 'x ≥ y ≤ z ≈ w ≠ v ∈ S ∪ T ⇒ a − b ↑ ↓ ↔ ↳ →';
    expect(checkHygiene(symbols, 'markdown')).toEqual([]);
    expect(checkHygiene(comment(symbols), 'code')).toEqual([]);

    const boxDrawing = comment('┌─────┬─────┐ │ ✓ ✗ ℹ ● ▶ ◆ ⚙ │ └─────┴─────┘');
    expect(checkHygiene(boxDrawing, 'code')).toEqual([]);
    expect(checkHygiene('const marks = "✓ ✗ ℹ ● ▶ ◆ ⚙";', 'code')).toEqual([]);
  });

  it('leaves the emoji the decoration rules own to those rules', () => {
    expect(ids('const route = "🚀 ship it 🎯 now";')).toEqual([]);
    expect(checkHygiene('## ✅ Ship the migration', 'markdown')).toEqual([
      expect.objectContaining({ id: 'decorative-emoji-doc' }),
    ]);
  });

  it('is exempted by the marker, so a deliberate fixture may carry the character', () => {
    const source = [HYGIENE_EXEMPT_MARKERS.code, comment('a 汉 fixture')].join('\n');
    expect(checkHygiene(source, 'code')).toEqual([]);
  });
});

describe('warn tier: verbosity and unresolved markers', () => {
  const block = (lines: number): string =>
    Array.from({ length: lines }, (_, i) => comment(`filler line ${i}`)).join('\n');

  it(`warns on a run of ${MAX_COMMENT_BLOCK_LINES} consecutive comment lines`, () => {
    const findings = checkHygiene(
      `const x = 1;\n${block(MAX_COMMENT_BLOCK_LINES)}\nexport {}`,
      'code',
    );
    expect(findings.map((f) => f.id)).toEqual(['long-comment-block']);
    expect(findings[0]?.tier).toBe('warn');
    expect(findings[0]?.line).toBe(2);
  });

  it('leaves a shorter run alone', () => {
    expect(checkHygiene(block(MAX_COMMENT_BLOCK_LINES - 1), 'code')).toEqual([]);
  });

  it('does not join two blocks across a blank comment line or a divider', () => {
    const broken = block(MAX_COMMENT_BLOCK_LINES - 1);
    const paragraphs = [`const x = 1;`, broken, '//', broken].join('\n');
    expect(ids(paragraphs)).not.toContain('long-comment-block');

    const dividers = Array.from({ length: MAX_COMMENT_BLOCK_LINES }, () =>
      comment('-'.repeat(10)),
    ).join('\n');
    expect(ids(dividers)).not.toContain('long-comment-block');
  });

  it('warns on a TODO or FIXME with no owner and no reason', () => {
    expect(ids(comment('TODO'))).toContain('bare-todo');
    expect(ids(comment('FIXME:'))).toContain('bare-todo');
    expect(ids(comment('TODO: tidy this up'))).toContain('bare-todo');
  });

  it('leaves a TODO alone when it names an owner or a reason', () => {
    expect(
      checkHygiene(comment('TODO(@alice): delete the shim once the bridge ships'), 'code'),
    ).toEqual([]);
    expect(
      checkHygiene(
        comment('FIXME(agaaaptr): revisit when the store admits a second writer'),
        'code',
      ),
    ).toEqual([]);
  });
});

describe('anchoring: ordinary writing does not fire', () => {
  it('leaves prose about steps alone, in both kinds', () => {
    const prose = 'The next step is to validate the input before writing it to the store.';
    expect(checkHygiene(prose, 'code')).toEqual([]);
    expect(checkHygiene(prose, 'markdown')).toEqual([]);
    expect(checkHygiene('First, read the configuration and then apply it.', 'markdown')).toEqual(
      [],
    );
  });

  it('leaves a comment holding a single equals sign alone', () => {
    expect(checkHygiene(comment('the flag is x = 1 while the cache is warm'), 'code')).toEqual([]);
    expect(checkHygiene(comment('compare with === once a == b holds'), 'code')).toEqual([]);
  });

  it('leaves a user-facing string holding an emoji alone', () => {
    expect(checkHygiene(`const message = 'Deploy complete ✅';`, 'code')).toEqual([]);
    expect(checkHygiene(`const docs = 'https://example.com/docs 🚀';`, 'code')).toEqual([]);
  });

  it('leaves document rules, tables and bullets alone', () => {
    const doc = [
      '# Title',
      '',
      '---',
      '',
      '| first | second |',
      '| --- | --- |',
      '',
      '- a bullet',
      '',
      'The word step appears here in ordinary prose.',
    ].join('\n');
    expect(checkHygiene(doc, 'markdown')).toEqual([]);
  });

  it('leaves an ordinary commented function alone', () => {
    const source = [
      '/**',
      ' * Returns the canonical project id for a directory.',
      ' */',
      'export function projectId(dir: string, separator: string): string {',
      '  // The trailing separator is not part of the identity.',
      '  const trimmed = dir.endsWith(separator) ? dir.slice(0, -1) : dir;',
      '  return trimmed;',
      '}',
    ].join('\n');
    expect(checkHygiene(source, 'code')).toEqual([]);
  });
});

describe('the exemption marker', () => {
  it('returns no findings for a file that carries the marker above them', () => {
    const source = [HYGIENE_EXEMPT_MARKERS.code, banner('Setup'), comment('Step 1: load')].join(
      '\n',
    );
    expect(checkHygiene(source, 'code')).toEqual([]);
  });

  it('accepts an indented marker, and the markdown marker in a document', () => {
    expect(
      checkHygiene([`  ${HYGIENE_EXEMPT_MARKERS.code}`, banner('Setup')].join('\n'), 'code'),
    ).toEqual([]);
    expect(
      checkHygiene([HYGIENE_EXEMPT_MARKERS.markdown, '## 🎯 Goals'].join('\n'), 'markdown'),
    ).toEqual([]);
  });

  it('exempts nothing when the marker stands below the first finding', () => {
    const source = [banner('Setup'), HYGIENE_EXEMPT_MARKERS.code].join('\n');
    expect(ids(source)).toEqual(['decorative-banner']);
  });

  it('does not accept the marker of the other kind', () => {
    expect(ids([HYGIENE_EXEMPT_MARKERS.markdown, banner('Setup')].join('\n'))).toEqual([
      'decorative-banner',
    ]);
  });

  it('is not matched by any rule', () => {
    for (const marker of Object.values(HYGIENE_EXEMPT_MARKERS)) {
      for (const rule of HYGIENE_RULES) {
        expect(rule.pattern.test(marker), `${rule.id} flags the marker`).toBe(false);
      }
    }
  });

  it('is what the rule source itself carries', () => {
    const source = readSource('../src/hygiene.ts');
    expect(source.split('\n').some((line) => line.trim() === HYGIENE_EXEMPT_MARKERS.code)).toBe(
      true,
    );
    expect(checkHygiene(source, 'code')).toEqual([]);
  });

  it('exempts the residue table that defines the forbidden tokens', () => {
    const source = readSource('../src/residue.ts');
    expect(source.split('\n').some((line) => line.trim() === HYGIENE_EXEMPT_MARKERS.code)).toBe(
      true,
    );
    expect(checkHygiene(source, 'code')).toEqual([]);
  });
});

describe('the checker', () => {
  it('reports the rule id, the tier, the line, the text, the rationale and the fix', () => {
    const findings = checkHygiene(['const a = 1;', banner('Setup')].join('\n'), 'code');
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.id).toBe(ruleOrFail('decorative-banner').id);
    expect(finding?.tier).toBe('fail');
    expect(finding?.line).toBe(2);
    expect(finding?.text).toBe(banner('Setup'));
    expect(finding?.rationale).toBe(ruleOrFail('decorative-banner').rationale);
    expect(finding?.fix).toBe(ruleOrFail('decorative-banner').fix);
  });

  it('returns findings in reading order and repeats itself exactly', () => {
    const source = [comment('TODO'), banner('Setup'), comment('Step 1: load')].join('\n');
    const findings = checkHygiene(source, 'code');
    expect(findings.map((f) => [f.line, f.id])).toEqual([
      [1, 'bare-todo'],
      [2, 'decorative-banner'],
      [3, 'workflow-narration'],
    ]);
    expect(checkHygiene(source, 'code')).toEqual(findings);
  });

  it('checks a rule only against the kind it declares', () => {
    const codeOnly = comment('✅ Done');
    expect(ids(codeOnly, 'code')).toEqual(['decorative-emoji-comment']);
    expect(checkHygiene(codeOnly, 'markdown')).toEqual([]);

    const proseOnly = '## 🎯 Goals';
    expect(checkHygiene(proseOnly, 'code')).toEqual([]);
    expect(ids(proseOnly, 'markdown')).toEqual(['decorative-emoji-doc']);
  });

  it('reports a rule once per line however often it matches', () => {
    expect(checkHygiene(comment('✅ ✨ done'), 'code')).toHaveLength(1);
  });
});
