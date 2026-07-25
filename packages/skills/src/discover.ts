import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './compiler.js';
import { parseIntegration } from './integrations-schema.js';
import type { BuiltinSkill, IntegrationDeclaration, IntegrationSkill } from './types.js';

// Package root = ONE level up from THIS module's directory. Works in every layout
// because `builtin/` is always a sibling of the dir this code runs from:
//  - vitest:  .../packages/skills/src/discover.ts   -> HERE = src   -> PKG_ROOT = package root
//  - built:   .../packages/skills/dist/index.js     -> HERE = dist  -> PKG_ROOT = package root
//             (tsup bundles everything into dist/index.js; `dirname` still yields `dist`.)
const HERE = dirname(fileURLToPath(import.meta.url)); // .../src  OR  .../dist
const PKG_ROOT = dirname(HERE); // .../packages/skills
export const BUILTIN_DIR = join(PKG_ROOT, 'builtin');
export const INTEGRATIONS_DIR = join(PKG_ROOT, 'integrations');

/** Read a `<name>/SKILL.md` + its optional `references/` directory. Shared by
 *  builtin + integration discovery (both share the SKILL.md + references shape;
 *  the difference is the `integration.json` declaration). */
function readSkillMd(dir: string): Pick<BuiltinSkill, 'skillMd' | 'frontmatter' | 'references'> {
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
  return { skillMd, frontmatter, references };
}

export function discoverBuiltin(builtinDir: string = BUILTIN_DIR): BuiltinSkill[] {
  const dirs = readdirSync(builtinDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
    .map((e) => e.name)
    .sort();
  return dirs.map((name) => {
    const dir = join(builtinDir, name);
    return { name, dir, ...readSkillMd(dir) };
  });
}

/**
 * Discover every shipped integration under `integrations/<name>/` (sibling of
 * `builtin/`). Each entry is a builtin-shaped skill (validated `SKILL.md` +
 * optional references) PLUS a parsed + validated `integration.json`
 * declaration. The dir is resolved relative to the package root by default —
 * when `integrationsDir` is overridden (tests), only that dir is scanned.
 *
 * Throws an aggregate error if any integration is malformed (missing
 * `SKILL.md`, bad frontmatter, or an `integration.json` that fails the Zod
 * schema) — fail-fast, atomic-ish, mirroring the builtin compiler's posture.
 */
export function discoverIntegrations(
  integrationsDir: string = INTEGRATIONS_DIR,
): IntegrationSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(integrationsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('noir-'))
      .map((e) => e.name)
      .sort();
  } catch {
    // No integrations/ dir (or unreadable) = no integrations shipped here.
    return [];
  }
  return entries.map((name) => {
    const dir = join(integrationsDir, name);
    const declarationRaw = JSON.parse(
      readFileSync(join(dir, 'integration.json'), 'utf8'),
    ) as unknown;
    let declaration: IntegrationDeclaration;
    try {
      declaration = parseIntegration(declarationRaw);
    } catch (err) {
      // ZodError → wrap with the integration's dir for an actionable message.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid integration.json in ${dir}: ${msg}`);
    }
    if (declaration.name !== name) {
      throw new Error(
        `Integration dir "${name}" must equal declaration name "${declaration.name}"`,
      );
    }
    return { name, dir, ...readSkillMd(dir), declaration, declarationRaw };
  });
}

/**
 * Discover the full shipped pack — builtins + integrations — in one call. Used
 * by `emitSkillsToDir` so `noir init`/`sync` emit BOTH (slice X goal). The
 * `integrationsDir` defaults to the sibling of `builtinDir` so a test fixture
 * that overrides only `builtinDir` cleanly resolves integrations to a
 * non-existent path (returns `[]`) instead of accidentally picking up the
 * shipped integrations.
 */
export function discoverAll(opts: { builtinDir?: string; integrationsDir?: string } = {}): {
  builtins: BuiltinSkill[];
  integrations: IntegrationSkill[];
} {
  const builtinDir = opts.builtinDir ?? BUILTIN_DIR;
  const integrationsDir = opts.integrationsDir ?? join(dirname(builtinDir), 'integrations');
  return {
    builtins: discoverBuiltin(builtinDir),
    integrations: discoverIntegrations(integrationsDir),
  };
}
