// v2 — the home-menu "update available" notice. Pure-function tests over
// `buildUpdateNotice` + `updateAdvice`: the semver downgrade guard (an older or
// equal cached version is never advertised as an upgrade) and the
// install-type-specific advice mapping. No TTY, no daemon, no network.

import { describe, expect, it } from 'vitest';
import { buildUpdateNotice, updateAdvice } from '../src/commands/update.js';

describe('updateAdvice — install-type-specific command', () => {
  it('native → noir update', () => {
    expect(updateAdvice('native')).toContain('noir update');
  });

  it('homebrew → brew upgrade noir', () => {
    expect(updateAdvice('homebrew')).toContain('brew upgrade noir');
  });

  it('scoop → scoop update noir', () => {
    expect(updateAdvice('scoop')).toContain('scoop update noir');
  });

  it('npm → npm install -g @noir-ai/cli@latest', () => {
    expect(updateAdvice('npm')).toContain('npm install -g @noir-ai/cli@latest');
  });

  it('unknown method → the universal noir update', () => {
    expect(updateAdvice('weird')).toContain('noir update');
  });
});

describe('buildUpdateNotice — semver guard', () => {
  it('returns a notice when the latest is strictly newer', () => {
    const n = buildUpdateNotice({
      method: 'native',
      currentVersion: '1.10.1',
      latestKnown: '1.11.0',
    });
    expect(n?.latestVersion).toBe('1.11.0');
    expect(n?.advice).toContain('noir update');
  });

  it('returns null when the latest is equal (not an upgrade)', () => {
    expect(
      buildUpdateNotice({ method: 'native', currentVersion: '1.11.0', latestKnown: '1.11.0' }),
    ).toBeNull();
  });

  it('returns null when the latest is older (downgrade guard)', () => {
    expect(
      buildUpdateNotice({ method: 'native', currentVersion: '1.11.0', latestKnown: '1.10.1' }),
    ).toBeNull();
  });

  it('returns null when there is no cached latest or no current version', () => {
    expect(
      buildUpdateNotice({ method: 'native', currentVersion: '1.11.0', latestKnown: null }),
    ).toBeNull();
    expect(
      buildUpdateNotice({ method: 'native', currentVersion: null, latestKnown: '1.11.0' }),
    ).toBeNull();
  });
});
