import { existsSync } from 'node:fs';
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

  // S10 multi-host — `compileSkill` widens from claude-only to the 5-host enum.
  // The verbatim branch (claude/agents-md/gemini/opencode) is byte-identical to
  // v1.1 (the regression anchor); the cursor branch transforms to .mdc.
  it.each(['claude', 'agents-md', 'gemini', 'opencode'] as const)(
    'S10: compileSkill(%j) emits the verbatim SKILL.md + references (canonical format)',
    async (target) => {
      const md = '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x\nbody';
      await writeSkill('noir-x', md, { 'detail.md': '# detail' });
      const skill = firstSkill(fixture);
      const out = compileSkill(skill, target);
      expect(out.files.map((f) => f.path.join('/'))).toEqual(['SKILL.md', 'references/detail.md']);
      expect(out.files[0]?.content).toBe(md);
    },
  );

  it('S10: compileSkill defaults to "claude" (backward-compatible with every existing caller)', async () => {
    const md = '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x\nbody';
    await writeSkill('noir-x', md, { 'detail.md': '# detail' });
    const skill = firstSkill(fixture);
    // No second arg — must behave exactly like compileSkill(skill, 'claude').
    const out = compileSkill(skill);
    expect(out.files.map((f) => f.path.join('/'))).toEqual(['SKILL.md', 'references/detail.md']);
    expect(out.files[0]?.content).toBe(md);
  });

  it('S10: compileSkill(cursor) transforms to <name>.mdc with description/globs/alwaysApply frontmatter', async () => {
    const md =
      '---\nname: noir-x\ndescription: Use when testing cursor transform.\n---\n# noir-x\nA body.';
    await writeSkill('noir-x', md);
    const skill = firstSkill(fixture);
    const out = compileSkill(skill, 'cursor');

    // ONE file named after the skill with the .mdc extension; no references dir
    // (Cursor's rule format has no references concept — references are dropped).
    expect(out.files.map((f) => f.path.join('/'))).toEqual(['noir-x.mdc']);
    const mdc = out.files[0]?.content ?? '';

    // Frontmatter block bounded by `---` lines.
    expect(mdc.startsWith('---\n')).toBe(true);
    const closeIdx = mdc.indexOf('\n---\n', 4);
    expect(closeIdx).toBeGreaterThan(0);
    const frontmatter = mdc.slice(4, closeIdx);
    // The skill's WHEN description drives Cursor's agent-decided rule selection.
    expect(frontmatter).toContain('description: Use when testing cursor transform.');
    // `globs: ['**/*']` — broad applicability; the description is the selector.
    // yaml.stringify quotes the wildcard entry, so we assert the literal pattern
    // (not the quote style — single vs double quotes is yaml's call).
    expect(frontmatter).toContain('globs:');
    expect(frontmatter).toContain('**/*');
    // `alwaysApply: false` per the S10 locked decision (agent-decided, not auto).
    expect(frontmatter).toContain('alwaysApply: false');

    // Body = the SKILL.md body (frontmatter stripped); no leakage of the original
    // frontmatter into the rendered rule body.
    const body = mdc.slice(closeIdx + '\n---\n'.length);
    expect(body).toContain('# noir-x');
    expect(body).toContain('A body.');
    expect(body).not.toContain('name: noir-x');
  });

  it('S10: compileSkill(cursor) drops the references/ dir (Cursor rules have no references concept)', async () => {
    await writeSkill('noir-x', '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x', {
      'extra.md': '# extra context',
    });
    const skill = firstSkill(fixture);
    const out = compileSkill(skill, 'cursor');
    // References are not emitted for the cursor target (documented risk in the
    // S10 spec — the body alone is the surface for Cursor's rule format).
    expect(out.files.map((f) => f.path.join('/'))).toEqual(['noir-x.mdc']);
    expect(out.files[0]?.content ?? '').not.toContain('extra context');
  });

  it('S10: all five targets are valid (no "Unsupported compile target" throw)', async () => {
    // Pre-S10, anything but 'claude' threw. After the widening, every HostId is
    // a legal CompileTarget — the validator runs, the format is selected, no
    // generic "unsupported" rejection.
    await writeSkill('noir-x', '---\nname: noir-x\ndescription: Use when testing.\n---\n# noir-x');
    const skill = firstSkill(fixture);
    for (const target of ['claude', 'agents-md', 'gemini', 'cursor', 'opencode'] as const) {
      expect(() => compileSkill(skill, target)).not.toThrow();
    }
  });

  // C3 — cursor skills must emit FLAT (.cursor/rules/<name>.mdc), NOT nested.
  // Cursor's rule loader scans `.cursor/rules/*.mdc` and does NOT recurse into
  // per-name subdirs; the prior nested `<name>/<name>.mdc` layout left skills
  // invisible to Cursor. The verbatim branch keeps the canonical nested shape.
  it('C3: emitSkillsToDir(cursor) writes .mdc FLAT under targetDir (no <name>/ subdir)', async () => {
    await writeSkill(
      'noir-x',
      '---\nname: noir-x\ndescription: Use when testing flat cursor.\n---\n# noir-x\nbody',
    );
    const target = join(fixture, '_out');
    await emitSkillsToDir(target, { builtinDir: fixture, target: 'cursor' });

    // FLAT: `<target>/noir-x.mdc` exists; `<target>/noir-x/noir-x.mdc` does NOT.
    const flatPath = join(target, 'noir-x.mdc');
    const nestedPath = join(target, 'noir-x', 'noir-x.mdc');
    expect(existsSync(flatPath)).toBe(true);
    expect(existsSync(nestedPath)).toBe(false);
    // The flat .mdc carries the compiled cursor shape (frontmatter + body).
    const mdc = await readFile(flatPath, 'utf8');
    expect(mdc).toContain('alwaysApply: false');
    expect(mdc).toContain('# noir-x');
  });

  it('C3: emitSkillsToDir(claude) keeps the canonical NESTED layout (regression anchor)', async () => {
    // The flat fix is cursor-only; the verbatim branch (claude/agents-md/gemini/
    // opencode) still lands at `<target>/<name>/SKILL.md` (+ references/).
    await writeSkill(
      'noir-x',
      '---\nname: noir-x\ndescription: Use when testing nested.\n---\n# noir-x\nbody',
    );
    const target = join(fixture, '_out');
    await emitSkillsToDir(target, { builtinDir: fixture, target: 'claude' });

    expect(existsSync(join(target, 'noir-x', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'noir-x.mdc'))).toBe(false);
    expect(existsSync(join(target, 'noir-x.mdc', 'SKILL.md'))).toBe(false);
  });

  it('C3+T2: cursor flat layout prunes stale .mdc FILES + legacy nested DIRS', async () => {
    // Pack ships only noir-keep. Pre-populate targetDir with:
    //   - noir-stale.mdc         (stale FLAT file — must be pruned)
    //   - noir-keep-legacy/      (legacy nested dir from pre-C3 cursor sync —
    //                             must be pruned even if name overlaps, since
    //                             the flat layout has no noir-*/ dirs at all)
    //   - my-custom-rule.mdc     (user-authored — UNTOUCHED, no noir- prefix)
    await writeSkill(
      'noir-keep',
      '---\nname: noir-keep\ndescription: Use when keeping.\n---\n# keep',
    );
    const target = join(fixture, '_out');
    const { mkdir, writeFile } = await import('node:fs/promises');
    // The other emitSkillsToDir tests rely on emitSkillsToDir itself creating
    // `target/` (it mkdir's recursively on emit). This test pre-populates
    // `target/` with stale files BEFORE the emit call to assert the prune — so
    // it must mkdir `target/` itself (otherwise the writeFile below ENOENTs).
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'noir-stale.mdc'), 'stale flat content', 'utf8');
    await mkdir(join(target, 'noir-keep-legacy'), { recursive: true });
    await writeFile(join(target, 'noir-keep-legacy', 'noir-keep-legacy.mdc'), 'legacy', 'utf8');
    await writeFile(join(target, 'my-custom-rule.mdc'), 'user-authored', 'utf8');

    const summary = await emitSkillsToDir(target, { builtinDir: fixture, target: 'cursor' });

    expect(summary.emitted).toContain('noir-keep');
    // Stale flat .mdc pruned; legacy nested dir pruned.
    // Cursor flat layout prunes stale `.mdc` FILES (reported WITH extension)
    // + legacy nested `noir-*/` DIRS (reported as dir names, no extension).
    expect(summary.pruned.sort()).toEqual(['noir-keep-legacy', 'noir-stale.mdc']);
    expect(existsSync(join(target, 'noir-stale.mdc'))).toBe(false);
    expect(existsSync(join(target, 'noir-keep-legacy'))).toBe(false);
    // The fresh flat .mdc is in place.
    expect(existsSync(join(target, 'noir-keep.mdc'))).toBe(true);
    // User-authored rule UNTOUCHED.
    expect(await readFile(join(target, 'my-custom-rule.mdc'), 'utf8')).toBe('user-authored');
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
