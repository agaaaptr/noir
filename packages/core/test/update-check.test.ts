import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isUpdateCheckDisabled,
  isUpdateStale,
  readUpdateCache,
  shouldCheckForUpdate,
  writeUpdateCache,
} from '../src/update-check.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-update-cache-'));
  prev = process.env.NOIR_UPDATE_CACHE_JSON;
  process.env.NOIR_UPDATE_CACHE_JSON = join(dir, 'update-cache.json');
});
afterEach(() => {
  if (prev === undefined) delete process.env.NOIR_UPDATE_CACHE_JSON;
  else process.env.NOIR_UPDATE_CACHE_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

const UPDATE = {
  checkEnabled: true,
  checkIntervalHours: 24,
  channel: 'latest' as const,
  minVersion: '1.6.0',
  display: 'notice' as const,
};

describe('update cache', () => {
  it('defaults to empty', () => {
    expect(readUpdateCache()).toEqual({ lastCheckAt: null, latestVersion: null, channel: null });
  });
  it('round-trips', () => {
    writeUpdateCache({
      lastCheckAt: '2026-08-03T00:00:00.000Z',
      latestVersion: '1.7.0',
      channel: 'latest',
    });
    expect(readUpdateCache()).toEqual({
      lastCheckAt: '2026-08-03T00:00:00.000Z',
      latestVersion: '1.7.0',
      channel: 'latest',
    });
  });
});

describe('isUpdateCheckDisabled', () => {
  it('false normally, true under CI or kill-switch', () => {
    expect(isUpdateCheckDisabled({})).toBe(false);
    expect(isUpdateCheckDisabled({ CI: 'true' })).toBe(true);
    expect(isUpdateCheckDisabled({ NOIR_DISABLE_UPDATE_CHECK: '1' })).toBe(true);
  });
});

describe('isUpdateStale', () => {
  it('stale when never checked, fresh within interval', () => {
    expect(isUpdateStale({ lastCheckAt: null, latestVersion: null, channel: null }, 24)).toBe(true);
    const now = Date.now();
    const recent = new Date(now - 60 * 60 * 1000).toISOString(); // 1h ago
    expect(
      isUpdateStale({ lastCheckAt: recent, latestVersion: '1.7.0', channel: 'latest' }, 24),
    ).toBe(false);
    const old = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    expect(isUpdateStale({ lastCheckAt: old, latestVersion: '1.7.0', channel: 'latest' }, 24)).toBe(
      true,
    );
  });
});

describe('shouldCheckForUpdate', () => {
  it('checks when enabled + stale + not disabled', () => {
    expect(
      shouldCheckForUpdate({
        env: {},
        configUpdate: UPDATE,
        cache: { lastCheckAt: null, latestVersion: null, channel: null },
      }),
    ).toBe(true);
  });
  it('skips when disabled, not stale, or configured off', () => {
    expect(
      shouldCheckForUpdate({
        env: { CI: 'true' },
        configUpdate: UPDATE,
        cache: { lastCheckAt: null, latestVersion: null, channel: null },
      }),
    ).toBe(false);
    expect(
      shouldCheckForUpdate({
        env: {},
        configUpdate: { ...UPDATE, checkEnabled: false },
        cache: { lastCheckAt: null, latestVersion: null, channel: null },
      }),
    ).toBe(false);
    expect(
      shouldCheckForUpdate({
        env: {},
        configUpdate: UPDATE,
        cache: { lastCheckAt: new Date().toISOString(), latestVersion: '1.7.0', channel: 'latest' },
      }),
    ).toBe(false);
  });
});
