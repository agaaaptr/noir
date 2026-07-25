import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileIntegration, emitSkillsToDir } from '../src/compiler.js';
import { discoverAll, discoverIntegrations } from '../src/discover.js';
import {
  IntegrationDeclarationSchema,
  parseIntegration,
  runtimeEmitsHostMcp,
  validateIntegration,
} from '../src/integrations-schema.js';

// ---------------------------------------------------------------------------
// Schema validation — valid + invalid shapes.
// ---------------------------------------------------------------------------
describe('integration.json schema', () => {
  it('parses the shipped ClickUp declaration', () => {
    const v = parseIntegration({
      name: 'noir-clickup',
      auth: { type: 'env-var', tokenEnv: 'CLICKUP_API_TOKEN', fallback: 'manual-paste' },
      runtime: 'gated-write-proxy',
      sdd: { intakeFrom: 'task', writeBack: ['status', 'subtasks'] },
      mcp: null,
    });
    expect(v.name).toBe('noir-clickup');
    expect(v.runtime).toBe('gated-write-proxy');
    expect(v.sdd.writeBack).toEqual(['status', 'subtasks']);
    expect(v.mcp).toBeNull();
  });

  it('applies documented defaults on a minimal declaration', () => {
    const v = parseIntegration({
      name: 'noir-x',
      auth: { type: 'env-var', tokenEnv: 'X_TOKEN' },
      runtime: 'none',
    });
    expect(v.auth.fallback).toBe('manual-paste'); // default
    expect(v.sdd.writeBack).toEqual([]); // default
    expect(v.mcp).toBeNull(); // default
  });

  it('rejects a non-noir- name', () => {
    expect(() =>
      parseIntegration({
        name: 'clickup',
        auth: { type: 'env-var', tokenEnv: 'X' },
        runtime: 'none',
      }),
    ).toThrow();
  });

  it('rejects an unknown auth type (no OAuth until keychain)', () => {
    expect(() =>
      parseIntegration({
        name: 'noir-x',
        auth: { type: 'oauth2' as unknown as 'env-var', tokenEnv: 'X' },
        runtime: 'none',
      }),
    ).toThrow();
  });

  it('rejects an unknown runtime tier', () => {
    expect(() =>
      parseIntegration({
        name: 'noir-x',
        auth: { type: 'env-var', tokenEnv: 'X' },
        runtime: 'runtime-xyz' as unknown as 'none',
      }),
    ).toThrow();
  });

  it('validateIntegration is non-throwing and reports messages', () => {
    const bad = validateIntegration({ name: 'bad-name', auth: {}, runtime: 'none' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);

    const good = validateIntegration({
      name: 'noir-x',
      auth: { type: 'env-var', tokenEnv: 'X' },
      runtime: 'none',
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.value.name).toBe('noir-x');
  });

  it('IntegrationDeclarationSchema is the canonical Zod object', () => {
    // Asserts the schema is exported + usable as a parser (callers may want the
    // raw Zod type, not just the convenience wrapper).
    expect(
      IntegrationDeclarationSchema.safeParse({
        name: 'noir-x',
        auth: { type: 'env-var', tokenEnv: 'X' },
        runtime: 'none',
      }).success,
    ).toBe(true);
  });
});

describe('runtimeEmitsHostMcp', () => {
  it('widens emission only for mcp-stdio + external-mcp', () => {
    expect(runtimeEmitsHostMcp('none')).toBe(false);
    expect(runtimeEmitsHostMcp('gated-write-proxy')).toBe(false);
    expect(runtimeEmitsHostMcp('mcp-stdio')).toBe(true);
    expect(runtimeEmitsHostMcp('external-mcp')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// discoverIntegrations() — finds + validates the shipped ClickUp integration.
// ---------------------------------------------------------------------------
describe('discoverIntegrations() — shipped pack', () => {
  it('finds noir-clickup with a valid declaration', () => {
    const integrations = discoverIntegrations();
    const names = integrations.map((i) => i.name);
    expect(names).toContain('noir-clickup');
    const cu = integrations.find((i) => i.name === 'noir-clickup');
    expect(cu).toBeDefined();
    if (!cu) return;
    expect(cu.declaration.auth.tokenEnv).toBe('CLICKUP_API_TOKEN');
    expect(cu.declaration.runtime).toBe('gated-write-proxy');
    expect(cu.declaration.sdd.intakeFrom).toBe('task');
    expect(cu.declaration.sdd.writeBack).toEqual(['status', 'subtasks']);
    expect(cu.declaration.mcp).toBeNull();
    // references/ ships (the clickup-api.md reference — also closes S5 debt).
    expect(cu.references.some((r) => r.name === 'clickup-api.md')).toBe(true);
  });

  it('returns [] when the integrations dir does not exist', () => {
    expect(discoverIntegrations(join(tmpdir(), 'noir-does-not-exist-xyz'))).toEqual([]);
  });
});

describe('discoverAll() — builtins + integrations merged', () => {
  it('returns both builtins and the ClickUp integration by default', () => {
    const all = discoverAll();
    expect(all.builtins.length).toBeGreaterThan(0);
    expect(all.integrations.map((i) => i.name)).toContain('noir-clickup');
  });
});

// ---------------------------------------------------------------------------
// compileIntegration() — host MCP emission widening.
// ---------------------------------------------------------------------------
describe('compileIntegration() — host MCP widening', () => {
  it('does NOT emit hostMcp for gated-write-proxy (ClickUp)', () => {
    const [cu] = discoverIntegrations().filter((i) => i.name === 'noir-clickup');
    if (!cu) throw new Error('noir-clickup missing');
    const compiled = compileIntegration(cu, 'claude');
    expect(compiled.hostMcp).toBeUndefined();
    expect(compiled.files.map((f) => f.path.join('/'))).toEqual([
      'SKILL.md',
      'references/clickup-api.md',
    ]);
  });

  it('emits hostMcp for an external-mcp fixture', async () => {
    const fixture = await writeFixtureIntegration({
      name: 'noir-fixture-external',
      runtime: 'external-mcp',
      mcp: { command: 'fixture-mcp', transport: 'stdio', args: ['--foo'] },
    });
    try {
      const integrations = discoverIntegrations(fixture);
      const fx = integrations.find((i) => i.name === 'noir-fixture-external');
      if (!fx) throw new Error('fixture missing');
      const compiled = compileIntegration(fx, 'claude');
      expect(compiled.hostMcp).toBeDefined();
      if (compiled.hostMcp) {
        expect(compiled.hostMcp.serverName).toBe('noir-fixture-external');
        expect(compiled.hostMcp.command).toBe('fixture-mcp');
        expect(compiled.hostMcp.args).toEqual(['--foo']);
        expect(compiled.hostMcp.transport).toBe('stdio');
      }
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('does NOT emit hostMcp for mcp-stdio when the mcp block is null', async () => {
    // Confirms compileIntegration guards against a null `mcp` even on a tier
    // that would otherwise widen emission (defensive — a mis-shipped declaration
    // should not crash the compiler).
    const fixture = await writeFixtureIntegration({
      name: 'noir-fixture-null',
      runtime: 'mcp-stdio',
      mcp: null,
    });
    try {
      const integrations = discoverIntegrations(fixture);
      const fx = integrations.find((i) => i.name === 'noir-fixture-null');
      if (!fx) throw new Error('fixture missing');
      const compiled = compileIntegration(fx, 'claude');
      expect(compiled.hostMcp).toBeUndefined();
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// emitSkillsToDir() — emits integrations alongside builtins when asked.
// ---------------------------------------------------------------------------
describe('emitSkillsToDir() — integrations opt-in', () => {
  it('emits the shipped integration under the default (no builtinDir override)', async () => {
    const target = await mkdtemp(join(tmpdir(), 'noir-emit-'));
    try {
      const summary = await emitSkillsToDir(target);
      expect(summary.integrations).toContain('noir-clickup');
      expect(summary.emitted).toContain('noir-clickup');
      // The SKILL.md + reference both landed under the target dir.
      const { readFile } = await import('node:fs/promises');
      const md = await readFile(join(target, 'noir-clickup', 'SKILL.md'), 'utf8');
      expect(md).toContain('# noir-clickup');
      const ref = await readFile(
        join(target, 'noir-clickup', 'references', 'clickup-api.md'),
        'utf8',
      );
      expect(ref).toContain('ClickUp API v2');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });

  it('does NOT pick up the shipped integrations when builtinDir is a fixture (sibling derivation)', async () => {
    // A test fixture overriding only builtinDir must NOT accidentally discover
    // the real shipped integrations/ — discoverAll derives integrationsDir as
    // the sibling of builtinDir, which under a tmpdir fixture does not exist.
    const fixture = await mkdtemp(join(tmpdir(), 'noir-skills-'));
    try {
      await mkdir(join(fixture, 'noir-a'), { recursive: true });
      await writeFile(
        join(fixture, 'noir-a', 'SKILL.md'),
        '---\nname: noir-a\ndescription: Use when a.\n---\n# a',
      );
      const target = join(fixture, '_out');
      const summary = await emitSkillsToDir(target, { builtinDir: fixture });
      expect(summary.emitted).toEqual(['noir-a']);
      expect(summary.integrations).toEqual([]);
    } finally {
      await rm(fixture, { recursive: true, force: true });
    }
  });

  it('includeIntegrations:false suppresses integration emission', async () => {
    const target = await mkdtemp(join(tmpdir(), 'noir-emit-'));
    try {
      const summary = await emitSkillsToDir(target, { includeIntegrations: false });
      expect(summary.integrations).toEqual([]);
      expect(summary.emitted).not.toContain('noir-clickup');
    } finally {
      await rm(target, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Fixture helper — writes a synthetic integration dir under a tmpdir's
// `integrations/` sibling so discoverIntegrations(tmpdir/integrations) finds it.
// ---------------------------------------------------------------------------
async function writeFixtureIntegration(
  decl: Omit<
    {
      name: string;
      auth?: { type: 'env-var'; tokenEnv: string; fallback?: 'manual-paste' | 'none' };
      runtime: 'none' | 'gated-write-proxy' | 'mcp-stdio' | 'external-mcp';
      mcp: { command: string; transport: 'stdio' | 'http'; args?: string[]; url?: string } | null;
    },
    'name' | 'runtime'
  > & { name: string; runtime: 'none' | 'gated-write-proxy' | 'mcp-stdio' | 'external-mcp' },
): Promise<string> {
  const tmp = await mkdtemp(join(tmpdir(), 'noir-integrations-'));
  const dir = join(tmp, 'integrations', decl.name);
  await mkdir(dir, { recursive: true });
  const json = {
    name: decl.name,
    auth: decl.auth ?? { type: 'env-var', tokenEnv: 'FIXTURE_TOKEN' },
    runtime: decl.runtime,
    sdd: {},
    mcp: decl.mcp ?? null,
  };
  await writeFile(join(dir, 'integration.json'), JSON.stringify(json), 'utf8');
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${decl.name}\ndescription: Use when testing the ${decl.name} fixture.\n---\n# ${decl.name}\n`,
    'utf8',
  );
  // Return the integrations/ dir (the arg discoverIntegrations expects).
  return dirname(dir);
}
