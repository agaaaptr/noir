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

describe('profile env — process-injection deny-list', () => {
  const denied = (env: Record<string, string | null>) =>
    resolveRunProfile('p', cfg({ profiles: { p: { binary: 'claude', env } } }), BASE);

  it('refuses a literal NODE_OPTIONS key, naming the key and the profile', () => {
    const r = denied({ NODE_OPTIONS: '--require=/tmp/evil.js' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('NODE_OPTIONS');
      expect(r.message).toContain('run profile "p"');
      expect(r.message).not.toContain('evil.js'); // names only, never a value
    }
  });

  it('refuses LD_PRELOAD and DYLD_INSERT_LIBRARIES', () => {
    expect(denied({ LD_PRELOAD: '/tmp/evil.so' }).ok).toBe(false);
    expect(denied({ DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib' }).ok).toBe(false);
  });

  it('refuses a deny-listed key even when its value is a null delete', () => {
    expect(denied({ NODE_OPTIONS: null }).ok).toBe(false);
  });

  it('allows a benign key like ANTHROPIC_BASE_URL (gateway passthrough is untouched)', () => {
    const r = denied({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.env?.ANTHROPIC_BASE_URL).toBe('https://api.z.ai/api/anthropic');
  });

  it('never scans values — a denied name expanded into a value is still allowed', () => {
    // ${VAR} expansion rewrites a VALUE only; no profile construction routes a
    // value into a key, so the deny-list stays key-based by design.
    const r = resolveRunProfile(
      'p',
      cfg({ profiles: { p: { binary: 'claude', env: { CUSTOM_VAR: REF('NODE_OPTIONS') } } } }),
      { ...BASE, NODE_OPTIONS: '--require=/tmp/evil.js' },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.profile.env?.CUSTOM_VAR).toBe('--require=/tmp/evil.js');
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
