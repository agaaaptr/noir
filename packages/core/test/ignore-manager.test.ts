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
