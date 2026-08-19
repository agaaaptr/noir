// Run profiles (Slice D): `run.profiles` in .noir/config.yml names host-binary
// bundles selected by `--profile` / NOIR_PROFILE / run.defaultProfile. Pure
// resolution + config-schema tests (offline); CLI integration lives in
// run-profiles-cli.test.ts.

import { parseConfig } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { expandEnvVars, listProfiles, resolveRunProfile } from '../src/run-profiles.js';

const BASE: Record<string, string | undefined> = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-real' };

function cfg(run: unknown): ReturnType<typeof parseConfig> {
  return parseConfig({ run });
}

describe('config schema — run block', () => {
  it('parses a valid profiles map + defaultProfile', () => {
    const config = cfg({
      defaultProfile: 'work',
      profiles: {
        work: { binary: '/Users/me/bin/claude-work', env: { CLAUDE_CONFIG_DIR: '/tmp/cc' } },
        lab: { binary: 'claude', args: ['--foo'] },
      },
    });
    expect(config.run?.defaultProfile).toBe('work');
    expect(config.run?.profiles?.work?.binary).toBe('/Users/me/bin/claude-work');
  });

  it('rejects a profile name with an invalid charset (dots/spaces/shell chars)', () => {
    expect(() => cfg({ profiles: { 'work.profile': { binary: 'x' } } })).toThrow();
    expect(() => cfg({ profiles: { 'a;rm': { binary: 'x' } } })).toThrow();
  });

  it('an absent run block still parses (built-in default behavior)', () => {
    const config = parseConfig({});
    expect(config.run?.profiles).toEqual({});
  });
});

describe('resolveRunProfile — precedence flag > env > defaultProfile > built-in', () => {
  const config = cfg({
    defaultProfile: 'work',
    profiles: {
      work: { binary: '/bin/claude-work' },
      lab: { binary: 'claude' },
    },
  });

  it('no request + no defaultProfile → built-in default (no profile applied)', () => {
    const bare = cfg({ profiles: { work: { binary: '/bin/claude-work' } } });
    expect(resolveRunProfile(undefined, bare, BASE)).toEqual({ ok: true, profile: {} });
  });

  it('explicit --profile wins', () => {
    const r = resolveRunProfile('lab', config, { ...BASE, NOIR_PROFILE: 'work' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.binary).toBe('claude');
  });

  it('NOIR_PROFILE env is used when no flag is given', () => {
    const r = resolveRunProfile(undefined, config, { ...BASE, NOIR_PROFILE: 'lab' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.binary).toBe('claude');
  });

  it('run.defaultProfile is the fallback', () => {
    const r = resolveRunProfile(undefined, config, BASE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.binary).toBe('/bin/claude-work');
  });

  it('unknown explicit name → error listing available profiles', () => {
    const r = resolveRunProfile('nope', config, BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('unknown run profile "nope"');
      expect(r.message).toContain('work');
      expect(r.message).toContain('lab');
    }
  });

  it('unknown name with no profiles → error noting none are defined', () => {
    const r = resolveRunProfile('nope', cfg({ profiles: {} }), BASE);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('none defined');
  });

  it('a missing defaultProfile target is a hard error (named → must exist)', () => {
    const r = resolveRunProfile(undefined, cfg({ defaultProfile: 'ghost', profiles: {} }), BASE);
    expect(r.ok).toBe(false);
  });
});

// Build a `${NAME}` placeholder at runtime so the source never contains a
// literal `${` (which the noTemplateCurlyInString lint would flag as an
// unintentional template interpolation).
const REF = (name: string): string => `${'$'}{${name}}`;

describe('profile env — dollar-brace expansion + null deletion', () => {
  it('expands a dollar-brace reference from the base env, leaving unresolved refs literal', () => {
    expect(expandEnvVars(REF('ANTHROPIC_API_KEY'), BASE)).toBe('sk-real');
    expect(expandEnvVars(`prefix-${REF('MISSING_XYZ')}-suffix`, BASE)).toBe(
      `prefix-${REF('MISSING_XYZ')}-suffix`,
    );
  });

  it('merges profile env with null meaning delete (resolves to undefined)', () => {
    const config = cfg({
      profiles: {
        clean: {
          binary: 'x',
          env: {
            ANTHROPIC_API_KEY: null,
            CLAUDE_CONFIG_DIR: REF('HOME'),
          },
        },
      },
    });
    const r = resolveRunProfile('clean', config, { ...BASE, HOME: '/tmp' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.profile.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(r.profile.env?.CLAUDE_CONFIG_DIR).toBe('/tmp');
    }
  });
});

describe('listProfiles', () => {
  it('marks the default profile and lists binary (keys match table() columns)', () => {
    const config = cfg({
      defaultProfile: 'work',
      profiles: { work: { binary: '/bin/w' }, lab: { binary: 'c' } },
    });
    const rows = listProfiles(config);
    expect(rows).toContainEqual({ NAME: 'work', DEFAULT: '*', BINARY: '/bin/w' });
    expect(rows).toContainEqual({ NAME: 'lab', DEFAULT: '', BINARY: 'c' });
  });
});
