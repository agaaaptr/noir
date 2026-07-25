import { describe, expect, it } from 'vitest';
import {
  bodyOf,
  compileIntegration,
  looksLikeWhenDescription,
  validateSkill,
} from '../src/compiler.js';
import { discoverIntegrations } from '../src/discover.js';
import { validateIntegration } from '../src/integrations-schema.js';
import { FORBIDDEN_RESIDUE } from '../src/residue.js';

const integrations = discoverIntegrations();

function expectNoResidue(text: string) {
  for (const tok of FORBIDDEN_RESIDUE) expect(text, `residue "${tok}"`).not.toContain(tok);
}

describe('integrations pack: shared hygiene', () => {
  it('every shipped integration has a noir- name, valid SKILL.md, valid integration.json', () => {
    expect(integrations.length).toBeGreaterThanOrEqual(1);
    for (const i of integrations) {
      // The dir must equal the declaration name; discoverIntegrations already
      // enforces this, but assert it here too for an actionable failure.
      expect(i.name).toMatch(/^noir-[a-z0-9-]+$/);
      expect(i.declaration.name).toBe(i.name);

      // Same SKILL.md hygiene as builtins: WHEN description + no forbidden residue.
      const res = validateSkill(i);
      expect(res.errors, `${i.name}: ${res.errors.join('; ')}`).toEqual([]);
      expect(looksLikeWhenDescription(i.frontmatter.description)).toBe(true);
      expectNoResidue(i.skillMd);
      for (const r of i.references) expectNoResidue(r.content);

      // Same body-substance bar as a builtin skill (a playbook, not a stub).
      expect(bodyOf(i.skillMd).length, `${i.name} body too short`).toBeGreaterThan(300);

      // integration.json round-trips through the schema.
      const v = validateIntegration(i.declarationRaw);
      expect(v.ok, `${i.name}: ${v.ok ? '' : v.errors.join('; ')}`).toBe(true);

      // References follow the same kebab.md naming as builtins.
      for (const r of i.references) {
        expect(r.name).toMatch(/^[a-z0-9-]+\.md$/i);
        expect(r.content.trim().length, `${i.name}: ${r.name} empty`).toBeGreaterThan(0);
      }
    }
  });

  it('noir-clickup ships + carries the gated-write-proxy contract + reference', () => {
    const cu = integrations.find((i) => i.name === 'noir-clickup');
    expect(cu, 'noir-clickup must ship in the integrations pack').toBeDefined();
    if (!cu) return;
    expect(cu.declaration.runtime).toBe('gated-write-proxy');
    expect(cu.declaration.auth).toEqual({
      type: 'env-var',
      tokenEnv: 'CLICKUP_API_TOKEN',
      fallback: 'manual-paste',
    });
    expect(cu.declaration.sdd).toEqual({ intakeFrom: 'task', writeBack: ['status', 'subtasks'] });
    expect(cu.declaration.mcp).toBeNull();
    // ClickUp writes route through the gated proxy → no host MCP emission.
    expect(compileIntegration(cu, 'claude').hostMcp).toBeUndefined();
    // references/clickup-api.md ships (closes S5 "references/ only covered by
    // synthetic fixtures" debt with a real reference doc).
    expect(cu.references.some((r) => r.name === 'clickup-api.md')).toBe(true);
  });
});
