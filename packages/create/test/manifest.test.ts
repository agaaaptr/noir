import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildManifest, MANIFEST_PATH_PARITY } from '../src/manifest.js';
import { loadTemplate, templatesDir } from '../src/template-loader.js';

const CTX = {
  projectId: '11111111-2222-3333-4444-555555555555',
  host: 'claude' as const,
  transport: 'stdio' as const,
};

describe('buildManifest', () => {
  const m = buildManifest(CTX);

  it('returns the expected entries with correct modes (snapshot)', () => {
    // Snapshot the (path, mode, host) triples — the contract S-T2 depends on.
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
      { path: '.mcp.json', mode: 'regenerate', host: 'claude', hasBlock: false },
      { path: 'CLAUDE.md', mode: 'managedBlock', host: 'claude', hasBlock: true },
      { path: 'CLAUDE.md', mode: 'managedBlock', host: 'claude', hasBlock: true },
      { path: '.gitignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.dockerignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.npmignore', mode: 'managedBlock', host: null, hasBlock: true },
      { path: '.prettierignore', mode: 'managedBlock', host: null, hasBlock: true },
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
