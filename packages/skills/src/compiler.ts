import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { discoverBuiltin } from './discover.js';
import type {
  BuiltinSkill,
  CompiledSkill,
  CompileTarget,
  EmitSummary,
  SkillFrontmatter,
  ValidationResult,
} from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_RE = /^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WHEN_START =
  /^(use|using|used|whenever|when|before|after|while|starting|encountering|completing|creating|about to|upon|during|to|for|on)\b/i;
const MAX_DESC = 1024;

export function parseFrontmatter(md: string): SkillFrontmatter {
  const m = md.match(FRONTMATTER_RE);
  if (!m) throw new Error('Skill missing YAML frontmatter (expected --- ... ---)');
  // Group 1 always exists when the regex matches; guard past noUncheckedIndexedAccess.
  const yaml = m[1];
  if (yaml === undefined) throw new Error('Skill missing YAML frontmatter (expected --- ... ---)');
  const fm = parseYaml(yaml) as SkillFrontmatter;
  if (typeof fm?.name !== 'string' || typeof fm?.description !== 'string') {
    throw new Error('Skill frontmatter requires string `name` + `description`');
  }
  return fm;
}

export function bodyOf(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** A WHEN description leads with its trigger. Requiring a leading cue — rather
 *  than a loose "contains when/before/after anywhere" — avoids false positives
 *  ("A tool that decides when to run tests") and accepts valid leads ("Upon…"). */
export function looksLikeWhenDescription(desc: string): boolean {
  return WHEN_START.test(desc.trim());
}

export function validateSkill(skill: BuiltinSkill): ValidationResult {
  const errors: string[] = [];
  const { name, description } = skill.frontmatter;
  if (!name) errors.push('missing `name`');
  else if (!NAME_RE.test(name)) errors.push(`name "${name}" must match noir-<kebab>`);
  if (basename(skill.dir) !== name) {
    errors.push(`dir "${basename(skill.dir)}" must equal name "${name}"`);
  }
  if (!description?.trim()) errors.push('missing `description`');
  else if (description.length > MAX_DESC) errors.push(`description exceeds ${MAX_DESC} chars`);
  else if (!looksLikeWhenDescription(description)) {
    errors.push('description must state WHEN to trigger (e.g. "Use when…"), not WHAT it does');
  }
  for (const r of skill.references) {
    if (!/^[a-z0-9-]+\.md$/i.test(r.name)) errors.push(`reference "${r.name}" must be <kebab>.md`);
    if (!r.content.trim()) errors.push(`reference "${r.name}" is empty`);
  }
  return { ok: errors.length === 0, errors };
}

export function compileSkill(skill: BuiltinSkill, target: CompileTarget = 'claude'): CompiledSkill {
  const res = validateSkill(skill);
  if (!res.ok) throw new Error(`Cannot compile ${skill.name}: ${res.errors.join('; ')}`);
  if (target !== 'claude') throw new Error(`Unsupported compile target: ${target}`);
  // Claude (v1) target = canonical format copied verbatim (DS-4). Multi-host transform is S10.
  const files = [
    { path: ['SKILL.md'], content: skill.skillMd },
    ...skill.references.map((r) => ({ path: ['references', r.name], content: r.content })),
  ];
  return { name: skill.name, files };
}

export async function emitSkillsToDir(
  targetDir: string,
  opts: { builtinDir?: string } = {},
): Promise<EmitSummary> {
  const skills = discoverBuiltin(opts.builtinDir);
  // Validate the whole pack before writing anything (fail-fast, atomic-ish).
  for (const s of skills) {
    const res = validateSkill(s);
    if (!res.ok) throw new Error(`Invalid builtin skill ${s.name}: ${res.errors.join('; ')}`);
  }
  await mkdir(targetDir, { recursive: true });
  let references = 0;
  for (const s of skills) {
    const compiled = compileSkill(s, 'claude');
    for (const f of compiled.files) {
      const dest = join(targetDir, s.name, ...f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.content, 'utf8');
      if (f.path[0] !== 'SKILL.md') references++;
    }
  }
  return { dir: targetDir, emitted: skills.map((s) => s.name), references };
}

// Convenience for callers/tests that already hold raw markdown (unused by emit path;
// kept so adapters/tests can validate a single in-memory skill without a dir).
export { discoverBuiltin };
