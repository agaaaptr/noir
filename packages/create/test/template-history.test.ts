import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { render } from '../src/template.js';
import { isStaleSeed, SEED_TEMPLATE_HISTORY } from '../src/template-history.js';

/**
 * Digest of the bytes recorded for scaffold version 1.1.0, taken from the
 * packaged templates when the snapshot was captured.
 *
 * This is the only defence the snapshot has. Once a later release rewrites the
 * shipped seed templates, the 1.1.0 text exists nowhere else — it cannot be
 * re-derived from the repository, and a transcription slip in the embedded
 * literal would be invisible: the staleness check would simply stop matching,
 * users would silently stop receiving refreshed seeds, and nothing would fail.
 * Re-recording a digest here is only correct after checking the new value
 * against the bytes users actually have on disk.
 */
const DIGEST_1_1_0 = {
  envExample: '9b5bdbce4a1523f3128edac959e4632e9096fffa4cf87cea1abc8849dfe35c00',
  rulesSeed: '21747f84a2c59bf044735013381bf063955fe8c7ae27f07bd2851b6cc1c87b7e',
} as const;

const digest = (text: string): string =>
  createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const v1_1_0 = SEED_TEMPLATE_HISTORY.find((e) => e.scaffoldVersion === '1.1.0');
if (!v1_1_0) throw new Error('history is missing the 1.1.0 entry');

/** A plausible post-upgrade render of the same seed: what Noir writes today,
 *  which differs from every recorded version by an added documentation line. */
const currentEnvExample = `${v1_1_0.envExample}\n# NEW_VAR=1\n`;
const currentRulesSeed = `${v1_1_0.rulesSeed}\n- A newly added working rule.\n`;

/** Arbitrary interpolation context — used only to show that rendering the
 *  recorded text through the real renderer leaves it unchanged. */
const VARS = {
  root: '/tmp/project',
  projectId: '9f1c0b7e-0000-4000-8000-000000000000',
  host: 'claude',
  transport: 'stdio',
  url: 'http://127.0.0.1:4123/mcp',
  command: '/usr/local/bin/noir',
};

describe('seed template history — snapshot fidelity', () => {
  it('records the 1.1.0 seeds byte-for-byte', () => {
    expect(digest(v1_1_0.envExample)).toBe(DIGEST_1_1_0.envExample);
    expect(digest(v1_1_0.rulesSeed)).toBe(DIGEST_1_1_0.rulesSeed);
  });

  it('contains no `{{` token in any recorded template', () => {
    // The comparison in `isStaleSeed` is raw-text-to-raw-file-bytes, which is
    // only sound while `render(text, vars) === text` for every recorded
    // template. A template that interpolates breaks that, so the assumption is
    // asserted here rather than left as a comment a future contributor might
    // not read: add the `render` call (and a `vars` argument) before recording
    // such a template.
    for (const entry of SEED_TEMPLATE_HISTORY) {
      expect(entry.envExample).not.toContain('{{');
      expect(entry.rulesSeed).not.toContain('{{');
    }
  });

  it('renders the recorded seeds unchanged with real interpolation vars', () => {
    expect(render(v1_1_0.envExample, VARS)).toBe(v1_1_0.envExample);
    expect(render(v1_1_0.rulesSeed, VARS)).toBe(v1_1_0.rulesSeed);
  });

  it('keeps the two seeds distinct', () => {
    // Guards the fixtures below: if the two templates ever collapsed to the
    // same text, every case would pass for the wrong reason.
    expect(v1_1_0.envExample).not.toBe(v1_1_0.rulesSeed);
    expect(SEED_TEMPLATE_HISTORY).toHaveLength(1);
  });
});

describe('isStaleSeed — .noir/.env.example', () => {
  it('reports an unedited older seed as stale', () => {
    expect(isStaleSeed('envExample', v1_1_0.envExample, currentEnvExample)).toBe(true);
  });

  it('does NOT report the current render as stale', () => {
    expect(isStaleSeed('envExample', currentEnvExample, currentEnvExample)).toBe(false);
  });

  it('does NOT report a user-edited file as stale', () => {
    const edited = `${v1_1_0.envExample}\n# our team's own token\nMY_TOKEN=abc\n`;
    expect(isStaleSeed('envExample', edited, currentEnvExample)).toBe(false);
  });

  it('does NOT report an edit that only removes text as stale', () => {
    // Deletion is the most common edit and the one a length-based heuristic
    // would misclassify; exact matching handles it for free.
    const trimmed = v1_1_0.envExample.replace(/^# .*CLICKUP_API_TOKEN.*$/m, '');
    expect(trimmed).not.toBe(v1_1_0.envExample); // the fixture actually deleted a line
    expect(trimmed.length).toBeLessThan(v1_1_0.envExample.length);
    expect(isStaleSeed('envExample', trimmed, currentEnvExample)).toBe(false);
  });

  it('does NOT report a line-ending conversion as stale (conservative)', () => {
    // A CRLF checkout matches no recorded version. Treating that as "user
    // owned" is the safe direction: a skipped refresh is a doc gap, a wrong
    // refresh destroys work.
    const crlf = v1_1_0.envExample.replace(/\n/g, '\r\n');
    expect(isStaleSeed('envExample', crlf, currentEnvExample)).toBe(false);
  });

  it('does NOT report an empty file as stale', () => {
    expect(isStaleSeed('envExample', '', currentEnvExample)).toBe(false);
  });
});

describe('isStaleSeed — .noir/rules/RULES.md', () => {
  it('reports an unedited older seed as stale', () => {
    expect(isStaleSeed('rulesSeed', v1_1_0.rulesSeed, currentRulesSeed)).toBe(true);
  });

  it('does NOT report the current render as stale', () => {
    expect(isStaleSeed('rulesSeed', currentRulesSeed, currentRulesSeed)).toBe(false);
  });

  it('does NOT report a user-edited file as stale', () => {
    const edited = v1_1_0.rulesSeed.replace(
      '- Commits stay local until explicitly pushed.',
      '- Commits stay local until explicitly pushed.\n- Never touch the production database.',
    );
    expect(edited).not.toBe(v1_1_0.rulesSeed); // fixture actually changed the text
    expect(isStaleSeed('rulesSeed', edited, currentRulesSeed)).toBe(false);
  });

  it('does NOT report an empty file as stale', () => {
    expect(isStaleSeed('rulesSeed', '', currentRulesSeed)).toBe(false);
  });
});

describe('isStaleSeed — a comparison stays inside its own seed', () => {
  it('does NOT match the OTHER seed’s recorded bytes', () => {
    // Each history entry records both seeds. The caller overwrites the file
    // when this returns true, so the working-rules bytes sitting in
    // `.noir/.env.example` must NOT read as a stale env seed (and the reverse).
    // The same bytes under their OWN seed name are stale (asserted above).
    expect(isStaleSeed('envExample', v1_1_0.rulesSeed, currentEnvExample)).toBe(false);
    expect(isStaleSeed('rulesSeed', v1_1_0.envExample, currentRulesSeed)).toBe(false);
  });

  it('does NOT report the other seed’s CURRENT render as stale either', () => {
    expect(isStaleSeed('envExample', currentRulesSeed, currentEnvExample)).toBe(false);
    expect(isStaleSeed('rulesSeed', currentEnvExample, currentRulesSeed)).toBe(false);
  });

  it('returns false when nothing matches and neither render is current', () => {
    expect(isStaleSeed('envExample', 'something else entirely\n', currentEnvExample)).toBe(false);
    expect(isStaleSeed('rulesSeed', 'something else entirely\n', currentRulesSeed)).toBe(false);
  });

  it('compares bytes, not trimmed or normalized text', () => {
    // Trailing whitespace is a difference. Being strict here keeps a
    // whitespace-only user edit from being mistaken for an untouched seed.
    expect(isStaleSeed('envExample', ` ${v1_1_0.envExample}`, currentEnvExample)).toBe(false);
    expect(isStaleSeed('envExample', v1_1_0.envExample.trimEnd(), currentEnvExample)).toBe(false);
  });
});
