import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeAdapter } from '@noir-ai/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { init } from '../src/init.js';
import { sync } from '../src/sync.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'noir-init-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('noir init / sync emit the builtin pack', () => {
  it('claude adapter targets .claude/skills', () => {
    expect(claudeAdapter.skillsDir?.({ root })).toBe(join(root, '.claude', 'skills'));
  });

  it('init writes all 31 skills to .claude/skills/<name>/SKILL.md', async () => {
    await init(root, { transport: 'stdio' });
    const dir = join(root, '.claude', 'skills');
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
      .map((e) => e.name)
      .sort();
    expect(names.length).toBe(31);
    const md = await readFile(join(dir, 'noir-brainstorm', 'SKILL.md'), 'utf8');
    expect(md).toContain('name: noir-brainstorm');
  });

  it('sync is idempotent (re-emits the same 31)', async () => {
    await init(root, { transport: 'stdio' });
    await sync(root);
    const dir = join(root, '.claude', 'skills');
    const names = (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
      .map((e) => e.name);
    expect(names.length).toBe(31);
  });
});
