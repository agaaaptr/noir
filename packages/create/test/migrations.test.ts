import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyInlineConflict,
  applyWithConflict,
  MIGRATIONS,
  runMigrations,
} from '../src/migrations/index.js';
import { scaffoldVersionPath, writeScaffoldVersion } from '../src/scaffold-version.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mig-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('migrations registry', () => {
  it('MIGRATIONS is non-empty (the synthetic 1.0.0→1.0.0 entry ships at v1)', () => {
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    expect(last).toBeDefined();
    expect(last?.from).toBe('1.0.0');
    expect(last?.to).toBe('1.0.0');
  });

  it('every migration has a runnable `run` and non-empty description', () => {
    for (const m of MIGRATIONS) {
      expect(typeof m.run).toBe('function');
      expect(m.description.length).toBeGreaterThan(0);
      expect(m.from).toMatch(/^\d+\.\d+\.\d+$/);
      expect(m.to).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});

describe('runMigrations', () => {
  it('executes scripts in the [from,to] window and reports the ran list', () => {
    const res = runMigrations(root, '1.0.0', '1.0.0');
    expect(res.ran).toContain('1.0.0→1.0.0');
    expect(res.from).toBe('1.0.0');
    expect(res.to).toBe('1.0.0');
    // Synthetic migration records a note; no conflicts in the default path.
    expect(res.notes.length).toBeGreaterThan(0);
    expect(res.conflicts).toEqual([]);
  });

  it('is a no-op window when from>to (no scripts qualify)', () => {
    const res = runMigrations(root, '2.0.0', '1.0.0');
    expect(res.ran).toEqual([]);
  });

  it('dryRun does not touch disk (synthetic conflict branch stays inert)', () => {
    process.env.NOIR_TEST_FORCE_CONFLICT = '1';
    try {
      mkdirSync(join(root, '.noir'), { recursive: true });
      writeScaffoldVersion(root, '1.0.0');
      const before = readFileSync(scaffoldVersionPath(root), 'utf8');
      runMigrations(root, '1.0.0', '1.0.0', { dryRun: true });
      const after = readFileSync(scaffoldVersionPath(root), 'utf8');
      expect(after).toBe(before);
    } finally {
      delete process.env.NOIR_TEST_FORCE_CONFLICT;
    }
  });

  it('NEVER throws and NEVER prompts: conflict path writes inline markers, returns them in result', () => {
    process.env.NOIR_TEST_FORCE_CONFLICT = '1';
    try {
      mkdirSync(join(root, '.noir'), { recursive: true });
      // Write an "ours" that the synthetic migration will conflict against.
      writeFileSync(scaffoldVersionPath(root), 'noir-scaffold=1.0.0\n', 'utf8');
      const res = runMigrations(root, '1.0.0', '1.0.0');
      expect(res.conflicts).toContain('.noir/scaffold-version');
      // The file now contains git-style conflict markers (no throw, no hang).
      const content = readFileSync(scaffoldVersionPath(root), 'utf8');
      expect(content).toContain('<<<<<<<');
      expect(content).toContain('=======');
      expect(content).toContain('>>>>>>>');
    } finally {
      delete process.env.NOIR_TEST_FORCE_CONFLICT;
    }
  });
});

describe('conflict-marker helpers', () => {
  it('applyInlineConflict produces git-style markers', () => {
    const out = applyInlineConflict('a\n', 'b\n', 'mine', 'theirs');
    expect(out).toBe('<<<<<<< mine\na\n=======\nb\n>>>>>>> theirs\n');
  });

  it('applyWithConflict returns input unchanged when ours===theirs (idempotent re-run)', () => {
    const same = 'noir-scaffold=1.0.0\n';
    const out = applyWithConflict(same, same, '.noir/scaffold-version');
    expect(out.conflicted).toBe(false);
    expect(out.text).toBe(same);
  });

  it('applyWithConflict emits markers when ours!==theirs', () => {
    const out = applyWithConflict('a\n', 'b\n', '.noir/scaffold-version');
    expect(out.conflicted).toBe(true);
    expect(out.text).toContain('<<<<<<<');
  });

  it('the stamp file path exists after writeScaffoldVersion (sanity for the conflict test fixture)', () => {
    mkdirSync(join(root, '.noir'), { recursive: true });
    writeScaffoldVersion(root, '1.0.0');
    expect(existsSync(scaffoldVersionPath(root))).toBe(true);
  });
});
