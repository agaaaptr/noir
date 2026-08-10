// Runtime-derived skill registry — C3.
//
// The registry is NOT a committed file: frontmatter is the single source of
// truth and `buildRegistry()` derives a queryable index from `discoverAll()`
// on demand (the CLI calls it; no drift risk, per the C3 decision D3). Every
// field comes from either frontmatter (`metadata.category`, `metadata.version`)
// or a shape check (`status` from the stub marker, `referenceCount`/`lines`
// from the discovered files).

import { discoverAll } from './discover.js';
import type { BuiltinSkill } from './types.js';

/** The pack-wide `noir-` namespace a registry entry always belongs to. */
export const NOIR_NAMESPACE = 'noir-';

/** One row in the derived registry. */
export interface SkillRegistryEntry {
  /** Canonical `noir-<kebab>` id (== dir name). */
  name: string;
  /** `builtin` for the shipped pack; `integration` for an `integrations/<name>/`. */
  kind: 'builtin' | 'integration';
  /** Category from `metadata.category`; falls back to the `noir-`-stripped name
   *  (a newly-authored skill still gets a sensible cell). */
  category: string;
  /** Per-skill version from `metadata.version`; defaults to `0.0.0` when absent
   *  (the pack-level version in package.json is the authoritative release). */
  version: string;
  /** `full` when the body has no `> **Stub:**` marker; `stub` otherwise. */
  status: 'full' | 'stub';
  /** The WHAT+WHEN description (the trigger the host sees). */
  description: string;
  /** Number of `references/*.md` files. */
  referenceCount: number;
  /** Total SKILL.md line count (frontmatter + body). */
  lines: number;
}

/** Derive the category from the skill name when `metadata.category` is absent. */
function fallbackCategory(name: string): string {
  return name.replace(/^noir-/, '') || 'general';
}

/** Map a discovered builtin/integration to a registry row. */
function toEntry(s: BuiltinSkill, kind: 'builtin' | 'integration'): SkillRegistryEntry {
  const category = s.frontmatter.metadata?.category?.trim() || fallbackCategory(s.name);
  const version = s.frontmatter.metadata?.version?.trim() || '0.0.0';
  const status: 'full' | 'stub' = s.skillMd.includes('> **Stub:**') ? 'stub' : 'full';
  const lines = s.skillMd.split('\n').length;
  return {
    name: s.name,
    kind,
    category,
    version,
    status,
    description: typeof s.frontmatter.description === 'string' ? s.frontmatter.description : '',
    referenceCount: s.references.length,
    lines,
  };
}

/**
 * Build the full registry from `discoverAll()` — builtins + integrations in
 * one list, sorted by name. Pure (no I/O beyond discovery); never throws for
 * a malformed skill (a discovery failure surfaces upstream, the same as the
 * compiler's fail-fast).
 */
export function buildRegistry(): SkillRegistryEntry[] {
  const { builtins, integrations } = discoverAll();
  return [
    ...builtins.map((b) => toEntry(b, 'builtin')),
    ...integrations.map((i) => toEntry(i, 'integration')),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Convenience: registry filtered to a single category (CLI grouping). */
export function registryByCategory(category: string): SkillRegistryEntry[] {
  return buildRegistry().filter((e) => e.category === category);
}
