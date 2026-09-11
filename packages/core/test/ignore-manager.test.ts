import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IGNORE_BLOCK, syncIgnores } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('syncIgnores', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-ig-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writes a managed block into .gitignore with the .noir/ runtime entries', () => {
    syncIgnores(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain(IGNORE_BLOCK.begin);
    expect(gi).toContain('/.noir/store/');
    expect(gi).toContain(IGNORE_BLOCK.end);
  });

  it('includes /.noir/handoff/ so `noir handoff --write` artifacts never pollute commits', () => {
    syncIgnores(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('/.noir/handoff/');
  });

  it('preserves user content outside the managed block and is idempotent', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\nbuild\n', 'utf8');
    syncIgnores(root);
    syncIgnores(root); // re-run → idempotent
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('node_modules');
    expect(gi).toContain('build');
    expect(gi).toContain('/.noir/store/');
    expect(gi.split(IGNORE_BLOCK.begin).length - 1).toBe(1);
  });

  it('writes .dockerignore/.npmignore/.prettierignore too', () => {
    syncIgnores(root);
    for (const f of ['.dockerignore', '.npmignore', '.prettierignore']) {
      expect(readFileSync(join(root, f), 'utf8')).toContain('.noir/');
    }
  });
});

/** The entries of the managed ignore block, in file order, comments + blanks
 *  stripped — i.e. exactly the patterns git would apply. */
function blockEntries(gitignore: string): string[] {
  const start = gitignore.indexOf(IGNORE_BLOCK.begin);
  const end = gitignore.indexOf(IGNORE_BLOCK.end);
  expect(start, 'managed block begin marker').toBeGreaterThanOrEqual(0);
  expect(end, 'managed block end marker').toBeGreaterThan(start);
  return gitignore
    .slice(start + IGNORE_BLOCK.begin.length, end)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

/** Minimal, root-anchored gitignore evaluator — LAST MATCH WINS, `*` stays
 *  inside one path segment. Deliberately not a general gitignore engine: it
 *  exists to pin the `.env.*` / `!.env.example` pair against the SHIPPED
 *  entries, so removing (or reordering) either line fails the assertions
 *  below. */
function isIgnored(entries: readonly string[], relPath: string): boolean {
  let ignored = false;
  for (const entry of entries) {
    const negated = entry.startsWith('!');
    const pattern = negated ? entry.slice(1) : entry;
    const rx = new RegExp(
      `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
    );
    if (rx.test(relPath) || rx.test(`/${relPath}`)) ignored = !negated;
  }
  return ignored;
}

describe('syncIgnores — managed entry list (spec 10)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-ig-list-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the env entries: the real file is ignored, the example is not', () => {
    syncIgnores(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gi).toContain('/.noir/.env');
    expect(gi).toContain('/.noir/.env.*');
    expect(gi).toContain('!/.noir/.env.example');
    // The negation must FOLLOW the glob (gitignore is order-sensitive).
    const lines = blockEntries(gi);
    expect(lines.indexOf('!/.noir/.env.example')).toBeGreaterThan(lines.indexOf('/.noir/.env.*'));
  });

  it('drops the three vestigial entries — nothing creates those paths', () => {
    syncIgnores(root);
    const gi = readFileSync(join(root, '.gitignore'), 'utf8');
    // No socket is ever created; the daemon records under ~/.noir/ (HOME-scoped,
    // never project-local); `.noir/state/` was never created at all. No
    // replacement entry is needed — removal is the correct outcome.
    expect(gi).not.toContain('/.noir/*.sock');
    expect(gi).not.toContain('/.noir/daemon.pid');
    expect(gi).not.toContain('/.noir/state/');
  });

  it('.env.local is ignored by the .env.* glob; .env.example is exempted', () => {
    syncIgnores(root);
    const entries = blockEntries(readFileSync(join(root, '.gitignore'), 'utf8'));
    expect(isIgnored(entries, '.noir/.env.local')).toBe(true);
    expect(isIgnored(entries, '.noir/.env.production')).toBe(true);
    expect(isIgnored(entries, '.noir/.env')).toBe(true);
    expect(isIgnored(entries, '.noir/.env.example')).toBe(false);
  });
});
