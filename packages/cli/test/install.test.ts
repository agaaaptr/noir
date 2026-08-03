import type { DetectResult } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @noir-ai/core at the boundary for the dismiss integration test. The
// pure buildMigrationPlan tests below don't touch any mocked symbol, so this
// is inert for them.
const coreMock = vi.hoisted(() => ({
  NOIR_VERSION: '1.6.0-test',
  readInstallRecord: vi.fn(
    () => null as ReturnType<typeof import('@noir-ai/core')['readInstallRecord']>,
  ),
  writeInstallRecord: vi.fn(),
  detectInstallMethods: vi.fn(async () => [] as DetectResult[]),
  detectActiveMethod: vi.fn(() => 'unknown'),
  runManagerCmd: vi.fn(async () => ({ code: 0, stdout: '', stderr: '' })),
  atomicWriteFile: vi.fn(),
  noirHome: vi.fn(() => '/tmp/noir-test-home'),
}));
vi.mock('@noir-ai/core', () => ({ ...coreMock }));

import type { InstallRecord } from '@noir-ai/core';
import { buildMigrationPlan, install } from '../src/commands/install.js';

describe('buildMigrationPlan (pure)', () => {
  it('targets native when a prior method is detected', () => {
    const detected: DetectResult[] = [
      {
        method: 'npm',
        version: '1.5.0',
        uninstallCmd: 'npm uninstall -g @noir-ai/cli',
        managerDetected: true,
      },
    ];
    const plan = buildMigrationPlan({
      detected,
      currentMethod: 'npm',
      targetSpec: 'latest',
      installedVersion: '1.5.0',
    });
    expect(plan.shouldMigrate).toBe(true);
    expect(plan.nativeVersion).toBe('latest');
    expect(plan.prevUninstallCmd).toBe('npm uninstall -g @noir-ai/cli');
  });

  it('flags a downgrade (target older than installed) without auto-uninstall', () => {
    const detected: DetectResult[] = [
      {
        method: 'npm',
        version: '1.7.0',
        uninstallCmd: 'npm uninstall -g @noir-ai/cli',
        managerDetected: true,
      },
    ];
    const plan = buildMigrationPlan({
      detected,
      currentMethod: 'npm',
      targetSpec: '1.6.0',
      installedVersion: '1.7.0',
    });
    expect(plan.isDowngrade).toBe(true);
    expect(plan.prevUninstallCmd).toBe('npm uninstall -g @noir-ai/cli'); // still NOT auto-run
    expect(plan.autoUninstall).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// install() --dismiss — C1 hardening (brief Step 2): persists the current CLI
// version on install.json's dismissedVersions so the migration banner stops
// showing for that version. Idempotent.
// ---------------------------------------------------------------------------

/** Capture stderr around `fn` (success/info go to stderr per S9). */
async function runStderr(fn: () => Promise<void>): Promise<{ stderr: string }> {
  const errChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = origErr;
  }
  return { stderr: errChunks.join('') };
}

describe('install() --dismiss (banner dismissal persistence)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('appends the current version to dismissedVersions and writes the record', async () => {
    const existing: InstallRecord = {
      method: 'npm',
      version: '1.6.0',
      channel: 'latest',
      installedAt: '2026-08-03T00:00:00.000Z',
    };
    coreMock.readInstallRecord.mockReturnValue(existing);

    await runStderr(() => install({ dismiss: true }));

    expect(coreMock.writeInstallRecord).toHaveBeenCalledTimes(1);
    const written = coreMock.writeInstallRecord.mock.calls[0]?.[0] as InstallRecord;
    expect(written.dismissedVersions).toEqual(['1.6.0-test']);
    // Preserves the rest of the record.
    expect(written.method).toBe('npm');
    expect(written.version).toBe('1.6.0');
  });

  it('is idempotent — does not duplicate an already-dismissed version', async () => {
    const existing: InstallRecord = {
      method: 'npm',
      version: '1.6.0',
      channel: 'latest',
      installedAt: 'x',
      dismissedVersions: ['1.6.0-test'],
    };
    coreMock.readInstallRecord.mockReturnValue(existing);

    await runStderr(() => install({ dismiss: true }));

    const written = coreMock.writeInstallRecord.mock.calls[0]?.[0] as InstallRecord;
    expect(written.dismissedVersions).toEqual(['1.6.0-test']); // no duplicate
  });

  it('prints "nothing to dismiss" when there is no install record', async () => {
    coreMock.readInstallRecord.mockReturnValue(null);
    const { stderr } = await runStderr(() => install({ dismiss: true }));
    expect(coreMock.writeInstallRecord).not.toHaveBeenCalled();
    expect(stderr).toMatch(/nothing to dismiss/);
  });
});
