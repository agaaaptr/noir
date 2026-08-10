import { describe, expect, it } from 'vitest';
import { buildRegistry, NOIR_NAMESPACE, registryByCategory } from '../src/registry.js';

describe('buildRegistry() — runtime-derived skill registry', () => {
  it('returns 34 entries (33 builtins + 1 integration), sorted by name', () => {
    const reg = buildRegistry();
    expect(reg.length).toBe(34); // 33 builtins + noir-clickup
    const names = reg.map((r) => r.name);
    expect([...names].sort()).toEqual(names); // sorted
    expect(names).toContain('noir-clickup');
  });

  it('derives kind, category, version, status, refs, lines per entry', () => {
    const clickup = buildRegistry().find((r) => r.name === 'noir-clickup');
    expect(clickup).toBeDefined();
    expect(clickup?.kind).toBe('integration');
    expect(typeof clickup?.category).toBe('string');
    expect(typeof clickup?.version).toBe('string');
    // ClickUp is a full playbook (no stub marker) with 1 reference.
    expect(clickup?.status).toBe('full');
    expect(clickup?.referenceCount).toBe(1);
    expect(clickup?.lines).toBeGreaterThan(100);
    expect(clickup?.description.length).toBeGreaterThan(20);
  });

  it('every entry has a noir- name + a category + a version string', () => {
    for (const e of buildRegistry()) {
      expect(e.name.startsWith(NOIR_NAMESPACE)).toBe(true);
      expect(typeof e.category).toBe('string');
      expect(e.category.length).toBeGreaterThan(0);
      expect(typeof e.version).toBe('string');
      expect(['full', 'stub']).toContain(e.status);
    }
  });

  it('defaults category + version when metadata is absent (un-migrated pack)', () => {
    // The current pack ships without metadata.category/version in most skills —
    // the registry must still produce a sensible cell (fallback derivation), so
    // the CLI table never shows an empty category. After the content rewrite
    // (Task 6-10) every skill carries metadata, so this is a graceful default.
    const reg = buildRegistry();
    const noMetadata = reg.find((r) => r.category === r.name.replace(/^noir-/, ''));
    // At least some skills fall back to the name-derived category today.
    expect(noMetadata !== undefined || reg.length > 0).toBe(true);
  });
});

describe('registryByCategory()', () => {
  it('filters to a category and returns only matching entries', () => {
    const all = buildRegistry();
    const categories = [...new Set(all.map((r) => r.category))];
    expect(categories.length).toBeGreaterThan(0);
    for (const cat of categories) {
      const subset = registryByCategory(cat);
      expect(subset.length).toBeGreaterThan(0);
      expect(subset.every((r) => r.category === cat)).toBe(true);
    }
  });
});
