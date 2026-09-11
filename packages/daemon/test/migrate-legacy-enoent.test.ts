// Fix A regression: `retireLegacyDaemonRecord` must treat an ENOENT from
// `readFileSync` (the file was deleted between `existsSync` and the read — a
// benign concurrent-retirement race) as a no-op, NOT as the misleading
// "cannot read the legacy daemon record" refusal. The mock makes `existsSync`
// and `readFileSync` disagree for EXACTLY the legacy record path the same way
// the race does, deterministically, while every other fs read passes through
// (so core's own package.json read at module load stays real).
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// Pin the legacy record path so the fs mock can target just this file.
const LEGACY = join(tmpdir(), 'noir-legacy-enoent', 'daemon.json');
process.env.NOIR_DAEMON_JSON = LEGACY;

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isLegacy = (p: unknown): boolean => String(p) === LEGACY;
  const passthroughRead = actual.readFileSync as unknown as (
    path: string,
    options?: unknown,
  ) => string;
  return {
    ...actual,
    existsSync: vi.fn((p: Parameters<typeof actual.existsSync>[0]) =>
      isLegacy(p) ? true : actual.existsSync(p),
    ),
    readFileSync: vi.fn((p: string, options?: unknown) => {
      if (isLegacy(p)) {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }
      return passthroughRead(p, options);
    }),
    rmSync: vi.fn(),
  };
});

import { readFileSync, rmSync } from 'node:fs';

const { retireLegacyDaemonRecord } = await import('../src/migrate-legacy-record.js');

describe('retireLegacyDaemonRecord — ENOENT race', () => {
  it('is a no-op when the record vanishes between existsSync and readFileSync', async () => {
    await expect(retireLegacyDaemonRecord()).resolves.toBeUndefined();
    expect(readFileSync).toHaveBeenCalled();
    // The file was never readable, so it must NOT be removed — and, critically,
    // no refusal was thrown either (the race resolves as "already gone").
    expect(rmSync).not.toHaveBeenCalled();
  });
});
