// SP-A — root-safety + idempotency guard (TDD).
//
// Bug (root-caused 2026-07-26): running `noir init` while cwd = `.noir/`
// created a NESTED `.noir/.noir/` with a fresh project.id, because
// `resolveProjectId()` minted a new id whenever `<root>/.noir/project.id` was
// absent and nothing guarded against `root` being (or being inside) a `.noir/`
// directory. These tests pin the fix: Noir refuses to scaffold at/inside `.noir/`
// and never creates the nested store.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSafeRoot, scaffold } from '../src/scaffold.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-safety-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('assertSafeRoot — refuses roots at/inside a .noir directory', () => {
  it('throws when root itself is a .noir directory', () => {
    const root = join(tmp, 'proj', '.noir');
    expect(() => assertSafeRoot(root)).toThrow(/\.noir/i);
  });

  it('throws when an ancestor is a .noir directory', () => {
    const root = join(tmp, 'proj', '.noir', 'sub');
    expect(() => assertSafeRoot(root)).toThrow(/\.noir/i);
  });

  it('throws for a doubly-nested .noir/.noir root', () => {
    const root = join(tmp, 'proj', '.noir', '.noir');
    expect(() => assertSafeRoot(root)).toThrow(/\.noir/i);
  });

  it('allows a normal project root that CONTAINS a .noir/ subdir', () => {
    const root = join(tmp, 'proj');
    mkdirSync(join(root, '.noir'), { recursive: true }); // legitimate store
    expect(() => assertSafeRoot(root)).not.toThrow();
  });

  it('allows an ordinary subdirectory of a project', () => {
    expect(() => assertSafeRoot(join(tmp, 'proj', 'src'))).not.toThrow();
  });
});

describe('scaffold — root-safety guard (regression: nested .noir/.noir bug)', () => {
  it('refuses to init when root is a .noir directory and writes nothing', async () => {
    const root = join(tmp, 'proj', '.noir');
    mkdirSync(root, { recursive: true });
    await expect(scaffold({ root, mode: 'init', transport: 'stdio' })).rejects.toThrow(/\.noir/i);
    // The bug: a nested .noir/.noir/ (+ project.id) must NOT have been created.
    expect(existsSync(join(root, '.noir'))).toBe(false);
    expect(existsSync(join(root, 'project.id'))).toBe(false);
  });

  it('refuses to create when the target is inside a .noir directory', async () => {
    const outer = join(tmp, 'proj', '.noir');
    mkdirSync(outer, { recursive: true });
    const root = join(outer, 'nested');
    await expect(scaffold({ root, mode: 'create', transport: 'stdio' })).rejects.toThrow(/\.noir/i);
  });

  it('--force does NOT weaken root-safety (the hard guard): still refuses inside .noir/', async () => {
    const root = join(tmp, 'proj', '.noir');
    mkdirSync(root, { recursive: true });
    await expect(scaffold({ root, mode: 'init', transport: 'stdio', force: true })).rejects.toThrow(
      /\.noir/i,
    );
    expect(existsSync(join(root, '.noir'))).toBe(false); // no nested store created
  });

  it('assertSafeRoot rejects a root with a trailing slash', () => {
    const root = `${join(tmp, 'proj', '.noir')}/`;
    expect(() => assertSafeRoot(root)).toThrow(/\.noir/i);
  });
});

describe('scaffold — already-initialized guard (SP-A)', () => {
  it('a 2nd init at a valid root is a NO-OP: nothing written/skipped, project.id preserved', async () => {
    const root = join(tmp, 'proj');
    const first = await scaffold({ root, mode: 'init', transport: 'stdio' });
    const idBefore = readFileSync(paths.projectId(root), 'utf8').trim();

    const second = await scaffold({ root, mode: 'init', transport: 'stdio' });

    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(first.noop).toBe(false); // fresh init is NOT a no-op
    expect(second.noop).toBe(true); // the already-init guard fired
    const idAfter = readFileSync(paths.projectId(root), 'utf8').trim();
    expect(idAfter).toBe(idBefore); // store DB name stays stable
    expect(second.projectId).toBe(first.projectId);
  });

  it('a 2nd create at an already-initialized root is a NO-OP', async () => {
    const root = join(tmp, 'proj');
    await scaffold({ root, mode: 'create', transport: 'stdio' });
    const second = await scaffold({ root, mode: 'create', transport: 'stdio' });
    expect(second.written).toEqual([]);
    expect(second.noop).toBe(true);
  });

  it('force: true bypasses the already-initialized guard and re-emits runtime files', async () => {
    const root = join(tmp, 'proj');
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    const second = await scaffold({ root, mode: 'init', transport: 'stdio', force: true });
    // On an unchanged tree the runtime re-emit is content-hash dedup'd to
    // `identical` (no disk write). The signal that --force bypassed the guard
    // is `noop === false` AND the run reached the manifest (written ∪ identical
    // non-empty) — NOT `written.length > 0` (that was the pre-dedup proxy).
    expect(second.noop).toBe(false);
    expect(second.written.length + second.identical.length).toBeGreaterThan(0);
  });

  it('upgrade: true is NOT blocked by the already-initialized guard', async () => {
    const root = join(tmp, 'proj');
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    const up = await scaffold({ root, mode: 'init', transport: 'stdio', upgrade: true });
    // Upgrade ran (migrationsRan non-empty) and was NOT blocked by the
    // already-init guard (noop === false). The re-emitted runtime subset is
    // dedup'd to `identical` on an unchanged tree.
    expect(up.noop).toBe(false);
    expect(up.migrationsRan.length).toBeGreaterThan(0);
  });
});
