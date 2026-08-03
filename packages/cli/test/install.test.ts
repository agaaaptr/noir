import type { DetectResult } from '@noir-ai/core';
import { describe, expect, it } from 'vitest';
import { buildMigrationPlan } from '../src/commands/install.js';

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
