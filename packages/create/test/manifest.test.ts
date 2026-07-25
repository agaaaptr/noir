import { join } from 'node:path';
import { type HostAdapter, type HostId, resolveAdapter } from '@noir-ai/adapters';
import { describe, expect, it } from 'vitest';
import { buildHostArtifacts, buildManifest, MANIFEST_PATH_PARITY } from '../src/manifest.js';
import { loadTemplate, templatesDir } from '../src/template-loader.js';

const CTX = {
  root: '/sample/root',
  projectId: '11111111-2222-3333-4444-555555555555',
  host: 'claude' as const,
  transport: 'stdio' as const,
};

describe('buildManifest', () => {
  const m = buildManifest(CTX);

  it('returns the expected entries with correct modes (snapshot)', () => {
    // Snapshot the (path, mode, host) triples — the contract S-T2 depends on.
    //
    // S10 delta (justified): the claude host gained an ADDITIVE `AGENTS.md`
    // entry (regenerate, host:'claude'). Per the S10 spec ("AGENTS.md
    // universal: always emit a root AGENTS.md ... for EVERY host"), AGENTS.md
    // is the 32-platform baseline that Claude Code reads natively alongside
    // CLAUDE.md. The addition is host-tagged so it only emits for claude (the
    // snapshot's host under test); the same row appears for every other host
    // via buildHostArtifacts. All pre-S10 claude entries (.mcp.json, CLAUDE.md
    // x2, host-agnostic store + ignores) are byte-identical in shape + order.
    const snap = m.map((e) => ({
      path: e.path,
      mode: e.mode,
      host: e.host ?? null,
      hasBlock: e.block !== undefined,
    }));
    expect(snap).toEqual([
      { path: '.noir/project.id', mode: 'skipIfExists', host: null, hasBlock: false },
      { path: '.noir/config.yml', mode: 'skipIfExists', host: null, hasBlock: false },
      { path: '.noir/NOIR.md', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.noir/rules/RULES.md', mode: 'skipIfExists', host: null, hasBlock: false },
      // --- host-agnostic ignores (still host:null) ---
      { path: '.gitignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.dockerignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.npmignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.prettierignore', mode: 'managedBlock', host: null, hasBlock: true },
      // --- S10 host-specific (claude) — additive AGENTS.md first, then v1.1 set ---
      { path: 'AGENTS.md', mode: 'regenerate', host: 'claude', hasBlock: false },
      { path: 'CLAUDE.md', mode: 'managedBlock', host: 'claude', hasBlock: true },
      { path: 'CLAUDE.md', mode: 'managedBlock', host: 'claude', hasBlock: true },
      { path: '.mcp.json', mode: 'regenerate', host: 'claude', hasBlock: false },
    ]);
  });

  it('every path is repo-relative POSIX (no leading "/", no drive, no "..")', () => {
    for (const e of m) {
      expect(e.path.startsWith('/')).toBe(false);
      expect(e.path.includes('\\')).toBe(false);
      expect(e.path.includes('..')).toBe(false);
      expect(e.path.length).toBeGreaterThan(0);
    }
  });

  it('every entry has exactly one of content/template', () => {
    for (const e of m) {
      const count = (e.content !== undefined ? 1 : 0) + (e.template !== undefined ? 1 : 0);
      expect(count, `${e.path}`).toBe(1);
    }
  });

  it('every managedBlock entry has a block', () => {
    for (const e of m) {
      if (e.mode === 'managedBlock') expect(e.block, `${e.path}`).toBeDefined();
    }
  });

  it('every template: resolves to an existing template file', () => {
    for (const e of m) {
      if (e.template !== undefined) {
        expect(() => loadTemplate(e.template), `${e.path} → ${e.template}`).not.toThrow();
      }
    }
  });

  it('paths mirror @noir-ai/core/layout.ts (parity check, catches layout drift)', () => {
    const root = '/sample/root';
    for (const [entryPath, layoutFn] of MANIFEST_PATH_PARITY) {
      expect(join(root, entryPath), `${entryPath}`).toBe(layoutFn(root));
    }
  });

  it('templatesDir() points at this package templates/ (resolves in source + built layouts)', () => {
    expect(templatesDir()).toContain('templates');
  });

  it('picks the stdio mcp template for stdio transport', () => {
    const e = buildManifest({ ...CTX, transport: 'stdio' }).find((x) => x.path === '.mcp.json');
    expect(e?.template).toBe('mcp.stdio.json.tmpl');
  });

  it('picks the http mcp template for streamable-http transport', () => {
    const e = buildManifest({
      ...CTX,
      transport: 'streamable-http',
      url: 'http://127.0.0.1:9/mcp',
    }).find((x) => x.path === '.mcp.json');
    expect(e?.template).toBe('mcp.http.json.tmpl');
  });

  it('tags host-side artifacts (.mcp.json + CLAUDE.md) with host:claude; store/ignore are host-agnostic', () => {
    const hostTagged = m.filter((e) => e.host !== undefined).map((e) => e.path);
    expect(hostTagged).toContain('.mcp.json');
    expect(hostTagged).toContain('CLAUDE.md');
    for (const agnostic of [
      '.noir/project.id',
      '.noir/config.yml',
      '.noir/NOIR.md',
      '.noir/rules/RULES.md',
      '.gitignore',
    ]) {
      expect(hostTagged).not.toContain(agnostic);
    }
  });
});

// ---------------------------------------------------------------------------
// S10 — `buildHostArtifacts` per-host emission matrix.
// ---------------------------------------------------------------------------

describe('buildHostArtifacts — emission contract per adapter (S10)', () => {
  const root = '/sample/root';

  function entries(host: HostId) {
    return buildHostArtifacts(resolveAdapter(host), {
      root,
      transport: 'stdio',
    });
  }
  function pathsFor(host: HostId): string[] {
    return entries(host).map((e) => e.path);
  }

  it('every host emits AGENTS.md at root (universal 32-platform baseline)', () => {
    for (const h of ['claude', 'agents-md', 'gemini', 'cursor', 'opencode'] as const) {
      expect(pathsFor(h)).toContain('AGENTS.md');
    }
  });

  it('claude emits CLAUDE.md (CONTEXT+RULES) + .mcp.json (template); AGENTS.md is additive', () => {
    const e = entries('claude');
    expect(e.filter((x) => x.path === 'CLAUDE.md')).toHaveLength(2);
    expect(e.filter((x) => x.path === 'CLAUDE.md').every((x) => x.template !== undefined)).toBe(
      true,
    );
    expect(pathsFor('claude')).toContain('.mcp.json');
    // .mcp.json keeps the template path (byte-identical to v1.1).
    expect(e.find((x) => x.path === '.mcp.json')?.template).toBe('mcp.stdio.json.tmpl');
  });

  it('gemini emits GEMINI.md (CONTEXT+RULES) + .gemini/mcp.json + AGENTS.md', () => {
    const e = entries('gemini');
    expect(e.filter((x) => x.path === 'GEMINI.md')).toHaveLength(2);
    // Gemini uses bare `@.noir/...` import syntax (no @import, no quotes).
    const ctxRegion = e.find((x) => x.path === 'GEMINI.md' && x.block?.name === 'context');
    expect(ctxRegion?.content).toBe('@.noir/NOIR.md');
    expect(pathsFor('gemini')).toContain('.gemini/mcp.json');
    // No CLAUDE.md leakage.
    expect(pathsFor('gemini')).not.toContain('CLAUDE.md');
  });

  it('cursor emits .cursor/rules/noir-rules.mdc + .cursor/mcp.json; no separate context file (AGENTS.md IS the context)', () => {
    const e = entries('cursor');
    expect(pathsFor('cursor')).toContain('.cursor/rules/noir-rules.mdc');
    expect(pathsFor('cursor')).toContain('.cursor/mcp.json');
    // The noir-rules .mdc carries the frontmatter body the cursor adapter owns.
    const mdc = e.find((x) => x.path === '.cursor/rules/noir-rules.mdc');
    expect(mdc?.content).toContain('alwaysApply: false');
    // No CLAUDE.md / GEMINI.md leakage.
    expect(pathsFor('cursor')).not.toContain('CLAUDE.md');
    expect(pathsFor('cursor')).not.toContain('GEMINI.md');
  });

  it('agents-md emits .mcp.json (Claude-shape; broadly compatible) + AGENTS.md', () => {
    const e = entries('agents-md');
    expect(pathsFor('agents-md')).toContain('.mcp.json');
    expect(e.find((x) => x.path === '.mcp.json')?.content).toContain('"mcpServers"');
    // No host-native context file (AGENTS.md IS the surface).
    expect(pathsFor('agents-md')).not.toContain('CLAUDE.md');
    expect(pathsFor('agents-md')).not.toContain('GEMINI.md');
  });

  it('opencode emits opencode.json (mcp block, type-tagged shape) + AGENTS.md', () => {
    const e = entries('opencode');
    expect(pathsFor('opencode')).toContain('opencode.json');
    const cfg = e.find((x) => x.path === 'opencode.json')?.content ?? '';
    const parsed = JSON.parse(cfg) as { $schema: string; mcp: { noir: unknown } };
    expect(parsed.$schema).toBe('https://opencode.ai/config.json');
    expect(parsed.mcp.noir).toEqual({
      type: 'local',
      command: ['noir', 'mcp', 'serve', '--stdio'],
    });
  });

  it('every entry is host-tagged (no undefined-host leakage) + repo-relative POSIX', () => {
    for (const h of ['claude', 'agents-md', 'gemini', 'cursor', 'opencode'] as const) {
      for (const e of entries(h)) {
        expect(e.host, `${h}:${e.path}`).toBe(h);
        expect(e.path.startsWith('/'), `${h}:${e.path}`).toBe(false);
        expect(e.path.includes('\\'), `${h}:${e.path}`).toBe(false);
        expect(e.path.includes('..'), `${h}:${e.path}`).toBe(false);
      }
    }
  });

  it('streamable-http transport propagates to non-claude MCP config content', () => {
    const e = buildHostArtifacts(resolveAdapter('gemini'), {
      root,
      transport: 'streamable-http',
      url: 'http://127.0.0.1:4321/mcp',
    });
    const cfg = JSON.parse(e.find((x) => x.path === '.gemini/mcp.json')?.content ?? '{}') as {
      mcpServers: { noir: { type: string; url: string } };
    };
    expect(cfg.mcpServers.noir).toEqual({ type: 'http', url: 'http://127.0.0.1:4321/mcp' });
  });

  it('throws when an adapter returns a path outside root (defensive)', () => {
    // Hand-roll a host adapter that returns an out-of-root MCP path to confirm
    // hostRel guards against it (a future adapter bug fails loudly).
    const rogue: HostAdapter = {
      id: 'claude',
      emitContext: () => '',
      emitMcpConfig: () => '{}',
      mcpConfigPath: () => '/elsewhere/mcp.json',
    };
    expect(() => buildHostArtifacts(rogue, { root, transport: 'stdio' })).toThrow(/not under root/);
  });
});
