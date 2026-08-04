import type { DetectResult, ProvisionedNode } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs so chmodSync doesn't throw ENOENT on the (never-written) shim
// when the test mocks atomicWriteFile from @noir-ai/core.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, chmodSync: vi.fn() };
});

// Mock @noir-ai/core at the boundary for the dismiss + provision integration
// tests. The pure buildMigrationPlan tests below don't touch any mocked
// symbol, so this is inert for them.
const coreMock = vi.hoisted(() => ({
  NOIR_VERSION: '1.6.0-test',
  MANAGED_NODE_VERSION: '22.23.2',
  readInstallRecord: vi.fn(
    () => null as ReturnType<typeof import('@noir-ai/core')['readInstallRecord']>,
  ),
  writeInstallRecord: vi.fn(),
  detectInstallMethods: vi.fn(async () => [] as DetectResult[]),
  detectActiveMethod: vi.fn(() => 'unknown'),
  runManagerCmd: vi.fn(
    async (_cmd: string[], _opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number }) =>
      ({ code: 0, stdout: '', stderr: '' }) as { code: number; stdout: string; stderr: string },
  ),
  atomicWriteFile: vi.fn(),
  noirHome: vi.fn(() => '/tmp/noir-test-home'),
  provisionManagedNode: vi.fn(
    async (): Promise<ProvisionedNode> => ({
      source: 'managed',
      version: '22.23.2',
      nodeBin: '/tmp/noir-test-home/runtime/v22.23.2/bin/node',
      npmBin: '/tmp/noir-test-home/runtime/v22.23.2/bin/npm',
      dir: '/tmp/noir-test-home/runtime/v22.23.2',
    }),
  ),
}));
vi.mock('@noir-ai/core', () => ({ ...coreMock }));

import type { InstallRecord } from '@noir-ai/core';
import { buildMigrationPlan, install, installManagedNode } from '../src/commands/install.js';

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

  // I2 — update.minVersion floor (config.ts:238). The floor is a hard lower
  // bound on the resolved target version; an explicit pin below it is refused
  // the same way a downgrade is. Mirrors the downgrade guard: only concrete
  // X.Y.Z versions are compared — 'latest'/'beta' resolve to the newest at
  // install time (always >= floor by definition), so they never trip the floor.
  describe('minVersion floor', () => {
    it('belowMinVersion true when target is a concrete version below the floor', () => {
      const plan = buildMigrationPlan({
        detected: [],
        currentMethod: 'unknown',
        targetSpec: '1.5.0',
        installedVersion: null,
        minVersion: '1.6.0',
      });
      expect(plan.belowMinVersion).toBe(true);
    });

    it('belowMinVersion false when target is at the floor', () => {
      const plan = buildMigrationPlan({
        detected: [],
        currentMethod: 'unknown',
        targetSpec: '1.6.0',
        installedVersion: null,
        minVersion: '1.6.0',
      });
      expect(plan.belowMinVersion).toBe(false);
    });

    it('belowMinVersion false when target is above the floor', () => {
      const plan = buildMigrationPlan({
        detected: [],
        currentMethod: 'unknown',
        targetSpec: '1.7.0',
        installedVersion: null,
        minVersion: '1.6.0',
      });
      expect(plan.belowMinVersion).toBe(false);
    });

    it('belowMinVersion false for channel targets (latest/beta) — resolved at install time', () => {
      expect(
        buildMigrationPlan({
          detected: [],
          currentMethod: 'unknown',
          targetSpec: 'latest',
          installedVersion: null,
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
      expect(
        buildMigrationPlan({
          detected: [],
          currentMethod: 'unknown',
          targetSpec: 'beta',
          installedVersion: null,
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('compares semantically, not lexically (1.10.0 >= 1.6.0)', () => {
      // A naive string compare would call 1.10.0 < 1.6.0 ('1.1' < '1.6').
      expect(
        buildMigrationPlan({
          detected: [],
          currentMethod: 'unknown',
          targetSpec: '1.10.0',
          installedVersion: null,
          minVersion: '1.6.0',
        }).belowMinVersion,
      ).toBe(false);
    });

    it('defaults the floor to 1.6.0 when minVersion is omitted (matches config default)', () => {
      // Omitted minVersion ⇒ the config default '1.6.0' applies.
      expect(
        buildMigrationPlan({
          detected: [],
          currentMethod: 'unknown',
          targetSpec: '1.5.0',
          installedVersion: null,
        }).belowMinVersion,
      ).toBe(true);
    });
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

// ---------------------------------------------------------------------------
// installManagedNode() -- P2: now delegates to provisionManagedNode (P1) and
// proceeds (no "not provisioned" error) for both the managed path and the
// system-Node fallback path. Records managedRuntimeVersion per source.
// ---------------------------------------------------------------------------

/** Capture stderr around `fn` (warn/info/success go to stderr per S9). */
async function runStderrFn<T>(fn: () => Promise<T>): Promise<{ stderr: string; result: T }> {
  const errChunks: string[] = [];
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  let result: T;
  try {
    result = await fn();
  } finally {
    process.stderr.write = origErr;
  }
  return { stderr: errChunks.join(''), result };
}

describe('installManagedNode() (P2 — provisions managed Node)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: provision returns the managed Node, npm install succeeds, and
    // the version probe returns a CLI version string.
    coreMock.provisionManagedNode.mockResolvedValue({
      source: 'managed',
      version: '22.23.2',
      nodeBin: '/tmp/noir-test-home/runtime/v22.23.2/bin/node',
      npmBin: '/tmp/noir-test-home/runtime/v22.23.2/bin/npm',
      dir: '/tmp/noir-test-home/runtime/v22.23.2',
    });
    coreMock.runManagerCmd.mockImplementation(async (cmd: string[]) => {
      // The second call (the `--version` probe) returns a version string.
      if (cmd.includes('--version')) return { code: 0, stdout: '1.6.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls provisionManagedNode and proceeds (no "not provisioned" error) on the managed path', async () => {
    const res = await installManagedNode({ env: {} });

    expect(coreMock.provisionManagedNode).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.runtimeSource).toBe('managed');
    // The old behavior returned `{ ok:false, error: 'managed Node not provisioned …' }`.
    // Asserting the absence of that string guards against regression.
    expect(JSON.stringify(res)).not.toMatch(/not provisioned/);
  });

  it('uses the provisioned node/npm paths (from ProvisionedNode) for install + version probe', async () => {
    await installManagedNode({ env: {} });

    // First runManagerCmd call = `npm install -g` using the provisioned npm.
    const installCall = coreMock.runManagerCmd.mock.calls[0]?.[0] as string[];
    expect(installCall[0]).toBe('/tmp/noir-test-home/runtime/v22.23.2/bin/npm');
    expect(installCall).toContain('install');
    expect(installCall).toContain('-g');
    expect(installCall.some((a) => /@noir-ai\/cli@/.test(a))).toBe(true);

    // Second call = `node bin.js --version` using the provisioned node.
    const verCall = coreMock.runManagerCmd.mock.calls[1]?.[0] as string[];
    expect(verCall[0]).toBe('/tmp/noir-test-home/runtime/v22.23.2/bin/node');
    expect(verCall).toContain('--version');
  });

  it('records managedRuntimeVersion = MANAGED_NODE_VERSION for the managed path', async () => {
    await installManagedNode({ env: {} });

    const written = coreMock.writeInstallRecord.mock.calls[0]?.[0] as InstallRecord;
    expect(written.method).toBe('native');
    // Version comes from the mocked version probe ('1.6.0\n' → trimmed).
    expect(written.version).toBe('1.6.0');
    expect(written.channel).toBe('latest');
    expect(written.managedRuntimeVersion).toBe('22.23.2');
  });

  it('returns {ok:false, error} when npm install fails (non-zero exit)', async () => {
    coreMock.runManagerCmd.mockImplementation(async (cmd: string[]) => {
      if (cmd.includes('--version')) return { code: 0, stdout: '1.6.0\n', stderr: '' };
      return { code: 1, stdout: '', stderr: 'EPERM: operation not permitted' };
    });

    const res = await installManagedNode({ env: {} });

    expect(res.ok).toBe(false);
    expect(res.version).toBeNull();
    expect(res.error).toMatch(/npm install failed/);
    expect(res.error).toMatch(/EPERM/);
    // No install record written on failure.
    expect(coreMock.writeInstallRecord).not.toHaveBeenCalled();
  });

  it('surfaces provisionManagedNode throw as {ok:false} (no unhandled rejection)', async () => {
    coreMock.provisionManagedNode.mockRejectedValue(
      new Error('managed-Node provision failed (network down) and no usable system Node'),
    );

    const res = await installManagedNode({ env: {} });

    expect(res.ok).toBe(false);
    expect(res.version).toBeNull();
    expect(res.error).toMatch(/managed-Node provision failed/);
    expect(res.error).toMatch(/network down/);
    expect(coreMock.writeInstallRecord).not.toHaveBeenCalled();
  });

  describe('system-Node fallback', () => {
    beforeEach(() => {
      // Fallback: provisionManagedNode returned a system Node (P1's fallback path).
      coreMock.provisionManagedNode.mockResolvedValue({
        source: 'system',
        version: '22.5.0',
        nodeBin: '/usr/local/bin/node',
        npmBin: '/usr/local/bin/npm',
        dir: '/usr/local/bin',
      });
    });

    it('warns and proceeds using the system node/npm paths', async () => {
      const { stderr, result } = await runStderrFn(() => installManagedNode({ env: {} }));

      expect(result.ok).toBe(true);
      expect(result.runtimeSource).toBe('system');
      expect(stderr).toMatch(/using system Node 22\.5\.0/);

      // First runManagerCmd call uses the SYSTEM npm path, not the managed one.
      const installCall = coreMock.runManagerCmd.mock.calls[0]?.[0] as string[];
      expect(installCall[0]).toBe('/usr/local/bin/npm');

      const verCall = coreMock.runManagerCmd.mock.calls[1]?.[0] as string[];
      expect(verCall[0]).toBe('/usr/local/bin/node');
    });

    it('records managedRuntimeVersion = "system-<v>" so doctor can distinguish', async () => {
      await installManagedNode({ env: {} });

      const written = coreMock.writeInstallRecord.mock.calls[0]?.[0] as InstallRecord;
      expect(written.managedRuntimeVersion).toBe('system-22.5.0');
    });
  });
});
