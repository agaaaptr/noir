import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectActiveMethod, uninstallCommandFor } from '../src/install-detect.js';
import { writeInstallRecord } from '../src/install-method.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-install-detect-'));
  prev = process.env.NOIR_INSTALL_JSON;
  process.env.NOIR_INSTALL_JSON = join(dir, 'install.json');
});

afterEach(() => {
  if (prev === undefined) delete process.env.NOIR_INSTALL_JSON;
  else process.env.NOIR_INSTALL_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('uninstallCommandFor', () => {
  it('returns the exact manager uninstall for each method', () => {
    expect(uninstallCommandFor('npm')).toBe('npm uninstall -g @noir-ai/cli');
    expect(uninstallCommandFor('pnpm')).toBe('pnpm remove -g @noir-ai/cli');
    expect(uninstallCommandFor('yarn')).toBe('yarn global remove @noir-ai/cli');
    expect(uninstallCommandFor('bun')).toBe('bun rm -g @noir-ai/cli');
    expect(uninstallCommandFor('homebrew')).toBe('brew uninstall noir');
    expect(uninstallCommandFor('scoop')).toBe('scoop uninstall noir');
    expect(uninstallCommandFor('unknown')).toBeNull();
    expect(uninstallCommandFor('native')).toBeNull();
  });
});

describe('detectActiveMethod', () => {
  it('reads the install record, defaults to unknown', () => {
    // No record → unknown
    expect(detectActiveMethod()).toBe('unknown');
    writeInstallRecord({ method: 'npm', version: '1.6.0', channel: 'latest', installedAt: 'x' });
    expect(detectActiveMethod()).toBe('npm');
  });
});
