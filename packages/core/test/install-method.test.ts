import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
});
