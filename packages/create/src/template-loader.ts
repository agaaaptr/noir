import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Template loader. Templates ship at `<pkg>/templates/` (see `files` in
 * package.json) and are read at runtime so non-code changes (copy tweaks, new
 * pointers) don't require a rebuild.
 *
 * Path resolution must work identically in three layouts:
 *  - source (vitest, tsx): this file at `packages/create/src/template-loader.ts`
 *    → `../templates/<name>`.
 *  - built (tsup): this file at `packages/create/dist/template-loader.js` →
 *    `../templates/<name>` (same relative offset — `dist/` and `src/` are both
 *    direct children of the package root, so `../templates` lands correctly).
 *  - packed (npm tarball): `templates/` is included per `files`, dist/ layout
 *    preserved → same as built.
 *
 * `NOIR_TEMPLATES_DIR` overrides everything (used by tests + downstream packs
 * that want to substitute their own template set without forking the engine).
 */

const DEFAULT_TEMPLATES_DIR = resolveTemplatesDir();

function resolveTemplatesDir(): string {
  const override = process.env.NOIR_TEMPLATES_DIR;
  if (override && override.length > 0) return resolve(override);
  // `import.meta.url` is this module's URL. Going up one level reaches the
  // package root in both source and built layouts (see file header).
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '..', 'templates');
}

/** Read a template's raw text by name (e.g. `noir.md.tmpl`). Throws on missing
 *  — an unknown template is a manifest bug and should fail loudly, not render
 *  an empty string silently. */
export function loadTemplate(name: string): string {
  return readFileSync(join(DEFAULT_TEMPLATES_DIR, name), 'utf8');
}

/** Resolve a template name to its absolute path (for diagnostics + tests). */
export function templatesDir(): string {
  return DEFAULT_TEMPLATES_DIR;
}
