import { CommanderError } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @noir-ai/core at the module boundary. update() only uses a handful of
// core symbols (detectActiveMethod, readInstallRecord, fetchLatestVersion,
// runManagerCmd). Pure buildUpdateTarget tests above don't call any of these,
// so the mock is inert for them.
const coreMock = vi.hoisted(() => ({
  detectActiveMethod: vi.fn(() => 'unknown' as string),
  readInstallRecord: vi.fn(
    (): {
      method: string;
      version: string;
      channel: string;
      installedAt: string;
      dismissedVersions?: string[];
    } | null => null,
  ),
  fetchLatestVersion: vi.fn(async () => null as string | null),
  runManagerCmd: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  shouldCheckForUpdate: vi.fn(() => false),
  readUpdateCache: vi.fn(() => ({ lastCheckAt: null, latestVersion: null, channel: null })),
  writeUpdateCache: vi.fn(),
}));
vi.mock('@noir-ai/core', () => ({ ...coreMock }));

import { buildUpdateTarget, update } from '../src/commands/update.js';
import { EXIT } from '../src/output.js';

describe('buildUpdateTarget (pure)', () => {
  it('uses the active method + target channel', () => {
    const t = buildUpdateTarget({
      method: 'npm',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.5.0',
      latestKnown: '1.6.0',
    });
    expect(t).toEqual({
      method: 'npm',
      targetSpec: 'latest',
      currentVersion: '1.5.0',
      latestKnown: '1.6.0',
      isUpgrade: true,
      belowMinVersion: false, // 1.6.0 is at the default floor (1.6.0)
    });
  });
  it('isUpgrade false when already current', () => {
    const t = buildUpdateTarget({
      method: 'native',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.6.0',
      latestKnown: '1.6.0',
    });
    expect(t.isUpgrade).toBe(false);
  });

  // T6 hardening — semver downgrade guard. The bare inequality check
  // (`latestKnown !== currentVersion`) treated a registry that returned an
  // OLDER version as an "upgrade", which would silently downgrade the install.
  // isUpgrade must require latestKnown to be STRICTLY NEWER (semver-greater).
  it('isUpgrade false when latestKnown is older than current (no silent downgrade)', () => {
    const t = buildUpdateTarget({
      method: 'native',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.7.0',
      latestKnown: '1.6.0', // registry returned an older version (e.g. beta/prerelease lag)
    });
    expect(t.isUpgrade).toBe(false);
  });
  it('isUpgrade compares semantically, not lexically (1.10.0 > 1.9.0)', () => {
    // A naive string comparison would call 1.10.0 < 1.9.0 ('1.1' < '1.9'). The
    // semver comparison must treat numeric components as numbers.
    const t = buildUpdateTarget({
      method: 'native',
      channel: 'latest',
      spec: undefined,
      currentVersion: '1.9.0',
      latestKnown: '1.10.0',
    });
    expect(t.isUpgrade).toBe(true);
  });
  it('isUpgrade false when either version is null', () => {
    expect(
      buildUpdateTarget({
        method: 'native',
        channel: 'latest',
        currentVersion: null,
        latestKnown: '1.7.0',
      }).isUpgrade,
    ).toBe(false);
    expect(
      buildUpdateTarget({
        method: 'native',
        channel: 'latest',
        currentVersion: '1.6.0',
        latestKnown: null,
      }).isUpgrade,
    ).toBe(false);
  });

  // I2 — update.minVersion floor (config.ts:238). The floor bounds the
  // latest-known version the registry returned: if the registry ever offers a
  // version below the configured floor (e.g. a beta/prerelease channel lag, or
  // a yanked/stale dist-tag), the update must refuse rather than downgrade the
  // install below the supported baseline. Mirrors the downgrade guard shape.
  describe('minVersion floor', () => {
    it('belowMinVersion true when latestKnown is below the floor', () => {
      const t = buildUpdateTarget({
        method: 'native',
        channel: 'latest',
        currentVersion: '1.6.0',
        latestKnown: '1.5.0',
        minVersion: '1.6.0',
      });
      expect(t.belowMinVersion).toBe(true);
    });

    it('belowMinVersion false when latestKnown is at the floor', () => {
      expect(
        buildUpdateTarget({
          method: 'native',
          channel: 'latest',
          currentVersion: '1.6.0',
          latestKnown: '1.6.0',
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('belowMinVersion false when latestKnown is above the floor', () => {
      expect(
        buildUpdateTarget({
          method: 'native',
          channel: 'latest',
          currentVersion: '1.6.0',
          latestKnown: '1.7.0',
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('belowMinVersion false when latestKnown is null (registry-unreachable handled separately)', () => {
      expect(
        buildUpdateTarget({
          method: 'native',
          channel: 'latest',
          currentVersion: '1.6.0',
          latestKnown: null,
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('compares semantically, not lexically (1.10.0 >= 1.6.0)', () => {
      expect(
        buildUpdateTarget({
          method: 'native',
          channel: 'latest',
          currentVersion: '1.6.0',
          latestKnown: '1.10.0',
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('defaults the floor to 1.6.0 when minVersion is omitted (matches config default)', () => {
      expect(
        buildUpdateTarget({
          method: 'native',
          channel: 'latest',
          currentVersion: '1.6.0',
          latestKnown: '1.5.0',
        }).belowMinVersion,
      ).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// update() — integration tests for the T6 hardening behaviors. The core
// module is mocked at the boundary (no real network, no real install record),
// so these stay offline/free.
// ---------------------------------------------------------------------------

/** Capture stderr around `fn` (info/warn/success go to stderr per S9). */
async function runStderr(fn: () => Promise<void>): Promise<{ stderr: string; err: unknown }> {
  const errChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    process.stderr.write = origErr;
  }
  return { stderr: errChunks.join(''), err };
}

describe('update() — NOIR_DISABLE_UPDATES kill-switch', () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.NOIR_DISABLE_UPDATES;
    vi.clearAllMocks();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.NOIR_DISABLE_UPDATES;
    else process.env.NOIR_DISABLE_UPDATES = saved;
  });

  it('refuses to run when NOIR_DISABLE_UPDATES is set (exit 2, never reaches network)', async () => {
    process.env.NOIR_DISABLE_UPDATES = '1';
    const { stderr, err } = await runStderr(() => update({}));
    expect(coreMock.fetchLatestVersion).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).exitCode).toBe(EXIT.USAGE);
    expect(stderr).toMatch(/NOIR_DISABLE_UPDATES/);
  });

  it('refuses under --json too (emits {ok:false} envelope, no network)', async () => {
    process.env.NOIR_DISABLE_UPDATES = '1';
    const { err } = await runStderr(() => update({ json: true }));
    expect(coreMock.fetchLatestVersion).not.toHaveBeenCalled();
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).exitCode).toBe(EXIT.USAGE);
  });
});

describe('update() — registry-unreachable message', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // fetch returns null → "Could not reach the registry."
    coreMock.fetchLatestVersion.mockResolvedValue(null);
    coreMock.readInstallRecord.mockReturnValue({
      method: 'native',
      version: '1.6.0',
      channel: 'latest',
      installedAt: 'x',
    });
  });

  it('says "Could not reach the registry" when fetch returns null (not "up to date")', async () => {
    const { stderr } = await runStderr(() => update({}));
    expect(stderr).toMatch(/Could not reach the registry/);
    expect(stderr).not.toMatch(/up to date/);
  });
});
