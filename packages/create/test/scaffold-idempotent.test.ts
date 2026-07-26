// B1 — scaffold idempotency (TDD). Pins the deliverables of TIER B1:
//   - `noir sync` on an unchanged tree writes NOTHING (managedBlock content-hash dedup).
//   - bare init on an initialized project no-ops (ScaffoldResult.noop=true) WITHOUT --upgrade.
//   - `.noir/ancestors.json` is written on a plain init/sync (not only --merge).
//   - a pre-1.3.0 project (project.id present, NO scaffold-version stamp) no-ops on bare init.
//   - a direct `scaffold()` API call in a TTY-mocked env without the interactive flag does
//     not throw a @clack prompt (the engine is hermetic — reads ScaffoldOptions.interactive,
//     never process.env for interactivity).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';
import { CURRENT_SCAFFOLD_VERSION } from '../src/scaffold-version.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-idem-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Snapshot mtime + size of every file under `root` (recursively) so a test can
 *  PROVE no bytes hit disk on a re-run (true zero-write idempotency). */
function snapshot(dir: string): Map<string, { mtimeMs: number; size: number }> {
  const out = new Map<string, { mtimeMs: number; size: number }>();
  const walk = (d: string, rel = ''): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name);
      const r = rel === '' ? name : `${rel}/${name}`;
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else out.set(r, { mtimeMs: st.mtimeMs, size: st.size });
    }
  };
  walk(dir);
  return out;
}

describe('B1 — noir sync on an unchanged tree writes NOTHING', () => {
  it('a second sync leaves every file byte- and mtime-identical (no disk writes)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    // First sync: establishes the post-init baseline (and seeds ancestors).
    await scaffold({ root, mode: 'sync', transport: 'stdio' });
    const before = snapshot(root);

    // Second sync on an UNCHANGED tree — must be a true no-op.
    const res = await scaffold({ root, mode: 'sync', transport: 'stdio' });

    expect(res.written).toEqual([]);
    // Every runtime file (regenerate + managedBlock) is content-hash dedup'd.
    expect(res.identical).toEqual(
      expect.arrayContaining([
        '.mcp.json',
        '.noir/NOIR.md',
        'CLAUDE.md',
        '.gitignore',
        '.dockerignore',
        '.npmignore',
        '.prettierignore',
      ]),
    );
    // No file's mtime/size changed → nothing was rewritten.
    const after = snapshot(root);
    for (const [rel, b] of before) {
      const a = after.get(rel);
      expect(a, `file ${rel} disappeared`).toBeDefined();
      expect(a?.mtimeMs, `file ${rel} was rewritten (mtime changed)`).toBe(b.mtimeMs);
      expect(a?.size, `file ${rel} size changed`).toBe(b.size);
    }
  });

  it('identical is reported (not written) for unchanged managed regions', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    const res = await scaffold({ root, mode: 'sync', transport: 'stdio' });
    expect(res.written).toEqual([]);
    expect(res.identical.length).toBeGreaterThan(0);
  });
});

describe('B1 — bare init on an initialized project no-ops', () => {
  it('returns ScaffoldResult.noop=true WITHOUT --upgrade (and writes nothing)', async () => {
    const first = await scaffold({ root, mode: 'init', transport: 'stdio' });
    expect(first.noop).toBe(false);

    const second = await scaffold({ root, mode: 'init', transport: 'stdio' });
    expect(second.noop).toBe(true);
    expect(second.written).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.identical).toEqual([]);
  });
});

describe('B1 — .noir/ancestors.json is seeded on every init/sync (unconditional)', () => {
  it('a plain init (no merge flag) writes .noir/ancestors.json', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    expect(existsSync(join(root, '.noir', 'ancestors.json'))).toBe(true);
  });

  it('a plain sync (no merge flag) updates .noir/ancestors.json', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    // sync reads + re-writes the ancestor snapshot (capture is unconditional).
    await scaffold({ root, mode: 'sync', transport: 'stdio' });
    expect(existsSync(join(root, '.noir', 'ancestors.json'))).toBe(true);
    // The map is non-empty (every managed region is captured).
    const raw = JSON.parse(readFileSync(join(root, '.noir', 'ancestors.json'), 'utf8'));
    expect(Object.keys(raw).length).toBeGreaterThan(0);
  });

  it('a no-op sync leaves ancestors.json mtime-stable (writeAncestors dedup)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    await scaffold({ root, mode: 'sync', transport: 'stdio' });
    const beforeMtime = statSync(join(root, '.noir', 'ancestors.json')).mtimeMs;
    // second unchanged sync — ancestors.json itself must NOT be rewritten.
    await scaffold({ root, mode: 'sync', transport: 'stdio' });
    const afterMtime = statSync(join(root, '.noir', 'ancestors.json')).mtimeMs;
    expect(afterMtime).toBe(beforeMtime);
  });
});

describe('B1 — pre-1.3.0 legacy project (project.id present, no scaffold-version) no-ops', () => {
  it('bare init no-ops when project.id is present even without a scaffold-version stamp', async () => {
    // Seed a pre-1.3.0 legacy shape: a valid project.id but NO scaffold-version.
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    const idBefore = readFileSync(paths.projectId(root), 'utf8').trim();
    // Wipe the stamp — simulates a project initialized under pre-1.3.0 Noir.
    rmSync(join(root, '.noir', 'scaffold-version'), { force: true });

    const res = await scaffold({ root, mode: 'init', transport: 'stdio' });

    // Widened guard: project.id presence alone short-circuits bare init.
    expect(res.noop).toBe(true);
    expect(res.written).toEqual([]);
    // The id is preserved (no re-generation → store DB name stays stable).
    const idAfter = readFileSync(paths.projectId(root), 'utf8').trim();
    expect(idAfter).toBe(idBefore);
  });

  it('--upgrade still re-emits on a pre-1.3.0 project (explicit migration entry)', async () => {
    await scaffold({ root, mode: 'init', transport: 'stdio' });
    rmSync(join(root, '.noir', 'scaffold-version'), { force: true });

    const res = await scaffold({ root, mode: 'init', transport: 'stdio', upgrade: true });
    expect(res.noop).toBe(false);
    // M4: fromVersion is null (no stamp) → migrations are skipped (no synthetic
    // 1.0.0→1.0.0 step), but the runtime subset is still re-emitted.
    expect(res.fromVersion).toBeNull();
    expect(res.migrationsRan).toEqual([]);
  });

  it('a project with NO identity (no project.id AND no scaffold-version) still initializes', async () => {
    // Sanity: the widened guard does not block a truly fresh project.
    const res = await scaffold({ root, mode: 'init', transport: 'stdio' });
    expect(res.noop).toBe(false);
    expect(existsSync(paths.projectId(root))).toBe(true);
    expect(res.toVersion).toBe(CURRENT_SCAFFOLD_VERSION);
  });
});

describe('B1 — direct scaffold() is hermetic (no @clack prompt from env)', () => {
  it('a TTY-mocked direct call without interactive/onConflict completes without prompting', async () => {
    // Mock a TTY environment. The bridge env is UNSET — a direct API caller
    // must not be prompted only because stdout/stdin look interactive.
    const savedStdout = process.stdout.isTTY;
    const savedStdin = process.stdin.isTTY;
    const savedNi = process.env.NOIR_NON_INTERACTIVE;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    delete process.env.NOIR_NON_INTERACTIVE;
    try {
      // No `interactive` flag, no `onConflict` — the engine must NOT reach for
      // @clack. It completes normally (defaults to overwrite conflictPolicy,
      // which never fires on a fresh tree anyway).
      const res = await scaffold({ root, mode: 'init', transport: 'stdio' });
      expect(res.noop).toBe(false);
      expect(res.written.length).toBeGreaterThan(0);
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: savedStdout,
        configurable: true,
      });
      Object.defineProperty(process.stdin, 'isTTY', { value: savedStdin, configurable: true });
      if (savedNi === undefined) delete process.env.NOIR_NON_INTERACTIVE;
      else process.env.NOIR_NON_INTERACTIVE = savedNi;
    }
  });
});
