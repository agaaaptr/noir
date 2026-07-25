import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bodyOf,
  compileSkill,
  discoverBuiltin,
  emitSkillsToDir,
  looksLikeWhenDescription,
  parseFrontmatter,
  validateSkill,
} from '../src/compiler.js';

let fixture: string;
beforeEach(async () => {
  fixture = await mkdtemp(join(tmpdir(), 'noir-skills-'));
});
afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

async function writeSkill(name: string, md: string, refs: Record<string, string> = {}) {
  const dir = join(fixture, name);
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(dir, 'references'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), md, 'utf8');
  for (const [n, c] of Object.entries(refs)) await writeFile(join(dir, 'references', n), c, 'utf8');
}

/** Returns the first discovered skill, throwing if none — a type-safe replacement
 *  for `const [skill] = discoverBuiltin(fixture)`, which under
 *  noUncheckedIndexedAccess yields `BuiltinSkill | undefined`. */
function firstSkill(dir: string) {
  const found = discoverBuiltin(dir);
  const first = found[0];
  if (!first) throw new Error(`no skill discovered under ${dir}`);
  return first;
}

describe('compiler: frontmatter', () => {
  it('parses name + description', () => {
    const fm = parseFrontmatter('---\nname: noir-x\ndescription: Use when testing.\n---\n# body');
    expect(fm.name).toBe('noir-x');
    expect(fm.description).toBe('Use when testing.');
  });
  it('throws on missing frontmatter', () => {
    expect(() => parseFrontmatter('# no frontmatter')).toThrow(/frontmatter/i);
  });
  it('bodyOf strips the frontmatter block', () => {
    expect(bodyOf('---\nname: noir-x\ndescription: y\n---\n# body')).toContain('# body');
  });
});

describe('compiler: WHEN heuristic', () => {
  it('accepts WHEN descriptions', () => {
    expect(looksLikeWhenDescription('Use when starting creative work.')).toBe(true);
    expect(looksLikeWhenDescription('Before claiming work is done.')).toBe(true);
  });
  it('accepts WHEN descriptions that lead with a broader cue', () => {
    // Was a false negative under the old "contains when/before/after" rule.
    expect(looksLikeWhenDescription('Upon starting a new feature, gather requirements.')).toBe(
      true,
    );
    expect(looksLikeWhenDescription('To create a spec, gather requirements first.')).toBe(true);
  });
  it('rejects pure-WHAT descriptions', () => {
    expect(looksLikeWhenDescription('Guides the agent through brainstorming with questions.')).toBe(
      false,
    );
    expect(looksLikeWhenDescription('A tool that dispatches subagents per task.')).toBe(false);
  });
  it('rejects descriptions containing a WHEN word but not LEADING with one', () => {
    // Was a false positive under the old loose "contains" fallback.
    expect(looksLikeWhenDescription('A tool that decides when to run tests.')).toBe(false);
    expect(looksLikeWhenDescription('Helper that fires after the build.')).toBe(false);
  });
});

describe('compiler: validateSkill', () => {
  it('passes a well-formed skill', async () => {
    await writeSkill(
      'noir-x',
      '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x\nbody',
    );
    const skill = firstSkill(fixture);
    expect(validateSkill(skill).ok).toBe(true);
  });
  it('rejects a non-noir name', async () => {
    // dir must be `noir-` prefixed to be discovered; the NAME inside is non-noir.
    await writeSkill(
      'noir-bad',
      '---\nname: brainstorm\ndescription: Use when testing.\n---\nbody',
    );
    const skill = firstSkill(fixture);
    expect(validateSkill(skill).ok).toBe(false);
  });
  it('rejects a name/dir mismatch', async () => {
    await writeSkill('noir-x', '---\nname: noir-y\ndescription: Use when testing.\n---\nbody');
    const skill = firstSkill(fixture);
    expect(validateSkill(skill).errors.join('; ')).toMatch(/dir .* must equal name/i);
  });
  it('rejects a WHAT description', async () => {
    await writeSkill(
      'noir-x',
      '---\nname: noir-x\ndescription: Guides the agent step by step.\n---\nbody',
    );
    const skill = firstSkill(fixture);
    expect(validateSkill(skill).errors.join('; ')).toMatch(/when to trigger/i);
  });
});

describe('compiler: compileSkill + emitSkillsToDir', () => {
  it('compileSkill is a verbatim copy for claude target', async () => {
    const md = '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x\nbody';
    await writeSkill('noir-x', md, { 'detail.md': '# detail' });
    const skill = firstSkill(fixture);
    const out = compileSkill(skill, 'claude');
    expect(out.files.map((f) => f.path.join('/'))).toEqual(['SKILL.md', 'references/detail.md']);
    expect(out.files[0]?.content).toBe(md);
  });
  it('compileSkill refuses an invalid skill', async () => {
    await writeSkill('noir-x', '---\nname: noir-x\ndescription: Guides things.\n---\nbody');
    const skill = firstSkill(fixture);
    expect(() => compileSkill(skill, 'claude')).toThrow(/Cannot compile noir-x/i);
  });
  it('emitSkillsToDir writes every skill + reference, idempotently', async () => {
    await writeSkill('noir-a', '---\nname: noir-a\ndescription: Use when a.\n---\n# a');
    await writeSkill('noir-b', '---\nname: noir-b\ndescription: Use when b.\n---\n# b', {
      'r.md': '# r',
    });
    const target = join(fixture, '_out');
    const s1 = await emitSkillsToDir(target, { builtinDir: fixture });
    expect(s1.emitted.sort()).toEqual(['noir-a', 'noir-b']);
    expect(s1.references).toBe(1);
    expect(await readFile(join(target, 'noir-a', 'SKILL.md'), 'utf8')).toContain('# a');
    expect(await readFile(join(target, 'noir-b', 'references', 'r.md'), 'utf8')).toContain('# r');
    // idempotent: second run yields the same files + counts
    const s2 = await emitSkillsToDir(target, { builtinDir: fixture });
    expect(s2.emitted.sort()).toEqual(['noir-a', 'noir-b']);
    expect((await readdir(join(target, 'noir-a'))).length).toBe(1);
  });
  it('emitSkillsToDir fails fast on an invalid pack (writes nothing for the bad one)', async () => {
    await writeSkill('noir-bad', '---\nname: noir-bad\ndescription: Guides things.\n---\nbody');
    const target = join(fixture, '_out');
    await expect(emitSkillsToDir(target, { builtinDir: fixture })).rejects.toThrow(
      /Invalid builtin skill/,
    );
  });

  it('T2: prunes a stale noir-* dir left by a previous version (idempotent + safe)', async () => {
    // Fresh pack ships only noir-keep. A prior version wrote noir-stale-thing
    // and a user-authored skill (no `noir-` prefix) lives alongside.
    await writeSkill(
      'noir-keep',
      '---\nname: noir-keep\ndescription: Use when keeping.\n---\n# keep',
    );
    const target = join(fixture, '_out');
    const { mkdir, writeFile } = await import('node:fs/promises');
    // Pre-populate the target with stale + user content (simulating a prior sync).
    await mkdir(join(target, 'noir-stale-thing'), { recursive: true });
    await writeFile(
      join(target, 'noir-stale-thing', 'SKILL.md'),
      '---\nname: noir-stale-thing\ndescription: Use when gone.\n---\nold',
      'utf8',
    );
    await mkdir(join(target, 'my-custom-skill'), { recursive: true });
    await writeFile(join(target, 'my-custom-skill', 'SKILL.md'), 'user-authored', 'utf8');

    const summary = await emitSkillsToDir(target, { builtinDir: fixture });

    // The fresh pack was emitted...
    expect(summary.emitted).toContain('noir-keep');
    // ...the stale noir-* dir was pruned and reported in the summary...
    expect(summary.pruned).toEqual(['noir-stale-thing']);
    // ...and the user-authored skill (no `noir-` prefix) is UNTOUCHED.
    const remaining = await readdir(target);
    expect(remaining.sort()).toEqual(['my-custom-skill', 'noir-keep']);
    expect(await readFile(join(target, 'my-custom-skill', 'SKILL.md'), 'utf8')).toBe(
      'user-authored',
    );
  });

  it('T2: empty `pruned` array when nothing stale (clean sync)', async () => {
    await writeSkill('noir-a', '---\nname: noir-a\ndescription: Use when a.\n---\n# a');
    const target = join(fixture, '_out');
    const summary = await emitSkillsToDir(target, { builtinDir: fixture });
    expect(summary.pruned).toEqual([]);
  });
});
