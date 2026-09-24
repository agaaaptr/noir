import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  atomicWriteFile,
  clearInstallRecord,
  installJsonPath,
  readInstallRecord,
  writeInstallRecord,
} from '../src/install-method.js';

// A renamable failure, armed per test: `atomicWriteFile` is asked to move its
// staged temp onto `renameTarget` and the rename throws instead (the shape of a
// cross-device rename, a permission wall, a full disk — an interruption the
// process is still alive to observe). `renameFrom` records where the temp was
// staged so the dot-prefix contract can be pinned too. Hoisted so the `node:fs`
// mock factory (also hoisted) can read it.
const rename = vi.hoisted(() => ({
  target: null as string | null,
  from: null as string | null,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realRename = actual.renameSync as unknown as (from: string, to: string) => void;
  return {
    ...actual,
    renameSync: vi.fn((from: string, to: string) => {
      rename.from = from;
      if (rename.target !== null && to === rename.target) {
        throw new Error('simulated interruption: the rename was cut off');
      }
      return realRename(from, to);
    }),
  };
});

let dir: string;
let prev: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-install-method-'));
  prev = process.env.NOIR_INSTALL_JSON;
  process.env.NOIR_INSTALL_JSON = join(dir, 'install.json');
});

afterEach(() => {
  rename.target = null;
  rename.from = null;
  if (prev === undefined) delete process.env.NOIR_INSTALL_JSON;
  else process.env.NOIR_INSTALL_JSON = prev;
  rmSync(dir, { recursive: true, force: true });
});

/** Names of the temp siblings `atomicWriteFile` left in `dir`, whatever their
 *  prefix — the check is deliberately shape-based, not name-based. */
const tempLeftovers = (): string[] => readdirSync(dir).filter((f) => f.includes('.tmp-'));

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
    // After rename there should be no `.out.txt.tmp-*` leftover.
    expect(tempLeftovers()).toEqual([]);
  });

  it('stages its temp file DOT-prefixed, next to the destination', () => {
    const target = join(dir, 'CLAUDE.md');
    atomicWriteFile(target, 'hello');

    // A leftover temp is only reachable through a kill no handler can catch, so
    // the NAME is the defense: a dot-prefixed sibling is out of the way of the
    // globs and tooling that walk the repo, where `CLAUDE.md.tmp-…` reads as a
    // document of its own.
    expect(rename.from).not.toBeNull();
    expect(basename(rename.from as string).startsWith('.')).toBe(true);
    expect(dirname(rename.from as string)).toBe(dir);
  });

  it('removes the temp sibling when the rename fails, leaving the destination intact', () => {
    const target = join(dir, 'CLAUDE.md');
    writeFileSync(target, 'ORIGINAL\n', 'utf8');
    rename.target = target;

    expect(() => atomicWriteFile(target, 'NEW\n')).toThrow(/simulated interruption/);

    // The primary guarantee: the user's content survives. An interrupted write
    // leaves the destination holding the old bytes, never a half-written mix.
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL\n');
    // And the staged temp is gone — a leftover `.CLAUDE.md.tmp-…` would both
    // show in git status and be walked by the context indexer.
    expect(tempLeftovers()).toEqual([]);
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
    'applies `mode` on a rewrite too — the requested mode wins over the existing one',
    () => {
      const target = join(dir, 'tightens.txt');
      atomicWriteFile(target, 'first');
      chmodSync(target, 0o644);
      // Regression: a mode argument must not be dropped just because the target
      // already existed. The old behaviour wrote the temp at umask (0644),
      // renamed, then chmod'd BACK to the pre-existing 0644 — so a rewritten
      // credential silently stayed world-readable.
      atomicWriteFile(target, 'second', { mode: 0o600 });
      expect(readFileSync(target, 'utf8')).toBe('second');
      expect(statSync(target).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    "with no `mode`, a rewrite still preserves the existing file's mode",
    () => {
      const target = join(dir, 'keeps.txt');
      atomicWriteFile(target, 'first');
      chmodSync(target, 0o640);
      // The legacy contract is unchanged for callers that pass no mode.
      atomicWriteFile(target, 'second');
      expect(readFileSync(target, 'utf8')).toBe('second');
      expect(statSync(target).mode & 0o777).toBe(0o640);
    },
  );
});
