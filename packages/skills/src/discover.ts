import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './compiler.js';
import type { BuiltinSkill } from './types.js';

// Package root = ONE level up from THIS module's directory. Works in every layout
// because `builtin/` is always a sibling of the dir this code runs from:
//  - vitest:  .../packages/skills/src/discover.ts   -> HERE = src   -> PKG_ROOT = package root
//  - built:   .../packages/skills/dist/index.js     -> HERE = dist  -> PKG_ROOT = package root
//             (tsup bundles everything into dist/index.js; `dirname` still yields `dist`.)
const HERE = dirname(fileURLToPath(import.meta.url)); // .../src  OR  .../dist
const PKG_ROOT = dirname(HERE); // .../packages/skills
export const BUILTIN_DIR = join(PKG_ROOT, 'builtin');

export function discoverBuiltin(builtinDir: string = BUILTIN_DIR): BuiltinSkill[] {
  const dirs = readdirSync(builtinDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
    .map((e) => e.name)
    .sort();
  return dirs.map((name) => {
    const dir = join(builtinDir, name);
    const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf8');
    const frontmatter = parseFrontmatter(skillMd);
    const refsDir = join(dir, 'references');
    let references: BuiltinSkill['references'] = [];
    try {
      references = readdirSync(refsDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => ({ name: f, content: readFileSync(join(refsDir, f), 'utf8') }));
    } catch {
      references = []; // no references/ dir is fine
    }
    return { name, dir, skillMd, frontmatter, references };
  });
}
