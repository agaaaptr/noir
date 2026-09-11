import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  atomicWriteFile,
  clearInstallRecord,
  installJsonPath,
  readInstallRecord,
  writeInstallRecord,
} from '../src/install-method.js';

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-install-method-'));
  prev = process.env.NOIR_INSTALL_JSON;
  process.env.NOIR_INSTALL_JSON = join(dir, 'install.json');
});

afterEach(() => {
  if (prev === undefined) delete process.env.NOIR_INSTALL_JSON;
  else process.env.NOIR_INSTALL_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe('install record', () => {
  it('read/write round-trips and clear removes', () => {
    expect(readInstallRecord()).toBeNull();
    writeInstallRecord({
      method: 'native',
      version: '1.6.0',
      channel: 'latest',
      installedAt: '2026-08-03T00:00:00.000Z',
    });
    const rec = readInstallRecord();
    expect(rec).not.toBeNull();
    expect(rec?.method).toBe('native');
    expect(rec?.version).toBe('1.6.0');
    clearInstallRecord();
    expect(readInstallRecord()).toBeNull();
  });

  it('ignores a malformed or missing file', () => {
    writeFileSync(installJsonPath(), '{not json', 'utf8');
    expect(readInstallRecord()).toBeNull();
  });
});

describe('atomicWriteFile', () => {
  it('writes via temp-then-rename (no temp file left behind)', () => {
    const target = join(dir, 'out.txt');
    atomicWriteFile(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
    // After rename there should be no `out.txt.tmp-*` leftover.
    const leftovers = require('node:fs')
      .readdirSync(dir)
      .filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  // The `mode` option lands the temp file at the requested mode BEFORE the
  // rename, so a caller writing a credential (daemon token, spec 6.1) never has
  // a window where the destination exists world-readable. POSIX-only: Windows
  // permissions are ACL-based and `mode` is ignored there.
  it.skipIf(process.platform === 'win32')('applies `mode` to a newly created file', () => {
    const target = join(dir, 'secret.txt');
    atomicWriteFile(target, 'hunter2', { mode: 0o600 });
    expect(readFileSync(target, 'utf8')).toBe('hunter2');
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    "ignores `mode` when the target exists — a rewrite preserves the file's mode",
    () => {
      const target = join(dir, 'keeps.txt');
      atomicWriteFile(target, 'first');
      chmodSync(target, 0o640);
      // A mode argument on an EXISTING target must not be applied: the rewrite
      // keeps 0o640 rather than dropping to the requested 0o600.
      atomicWriteFile(target, 'second', { mode: 0o600 });
      expect(readFileSync(target, 'utf8')).toBe('second');
      expect(statSync(target).mode & 0o777).toBe(0o640);
    },
  );
});
