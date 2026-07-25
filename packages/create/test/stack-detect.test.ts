import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectStack } from '../src/stack-detect.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-stack-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

describe('detectStack (read-only, never throws, never assumes)', () => {
  it('returns an empty StackInfo on a totally foreign/empty dir', () => {
    const info = detectStack(root);
    expect(info.languages).toEqual([]);
    expect(info.monorepo).toBe(false);
    expect(info.frameworks).toEqual([]);
    expect(info.packageManager).toBeNull();
  });

  it('never throws even when files are malformed', () => {
    write('package.json', '{ this is not json');
    const info = detectStack(root);
    // Malformed package.json → treated as absent; no crash.
    expect(info.languages).toEqual([]);
  });

  it('detects typescript when package.json has typescript devDep OR tsconfig.json is present', () => {
    write('package.json', JSON.stringify({ name: 'x', devDependencies: { typescript: '^5' } }));
    expect(detectStack(root).languages).toContain('typescript');
  });

  it('detects plain javascript when package.json has no typescript', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    expect(detectStack(root).languages).toContain('javascript');
    expect(detectStack(root).languages).not.toContain('typescript');
  });

  it('detects python via pyproject.toml and fastapi in deps', () => {
    write('pyproject.toml', '[project]\nname="x"\ndependencies=["fastapi"]\n');
    const info = detectStack(root);
    expect(info.languages).toContain('python');
    expect(info.frameworks).toContain('fastapi');
  });

  it('detects go via go.mod and sets packageManager', () => {
    write('go.mod', 'module example.com/x\ngo 1.22\n');
    const info = detectStack(root);
    expect(info.languages).toContain('go');
    expect(info.packageManager).toBe('go-modules');
  });

  it('detects rust via Cargo.toml + axum framework', () => {
    write('Cargo.toml', '[package]\nname="x"\n[dependencies]\naxum="0.7"\n');
    const info = detectStack(root);
    expect(info.languages).toContain('rust');
    expect(info.frameworks).toContain('axum');
    expect(info.packageManager).toBe('cargo');
  });

  it('does NOT report actix for a Cargo.toml that only has actix-web (M3)', () => {
    // `actix-web = "4"` used to false-positive as `actix` because the old
    // regex `/^\s*actix\b/m` saw a word boundary between `x` and `-`.
    write('Cargo.toml', '[package]\nname="x"\n[dependencies]\nactix-web = "4"\n');
    const info = detectStack(root);
    expect(info.languages).toContain('rust');
    expect(info.frameworks).not.toContain('actix');
    expect(info.frameworks).toContain('actix-web');
  });

  it('reports actix only for a bare `actix = "4"` dependency (M3)', () => {
    write('Cargo.toml', '[package]\nname="x"\n[dependencies]\nactix = "4"\n');
    const info = detectStack(root);
    expect(info.frameworks).toContain('actix');
    // And NOT actix-web (the hyphenated crate is a separate id).
    expect(info.frameworks).not.toContain('actix-web');
  });

  it('detects monorepo via pnpm-workspace.yaml', () => {
    write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n');
    const info = detectStack(root);
    expect(info.monorepo).toBe(true);
    expect(info.packageManager).toBe('pnpm');
  });

  it('detects monorepo via package.json workspaces array', () => {
    write('package.json', JSON.stringify({ name: 'x', workspaces: ['packages/*'] }));
    expect(detectStack(root).monorepo).toBe(true);
  });

  it('detects monorepo via turbo.json or nx.json', () => {
    write('turbo.json', '{}');
    expect(detectStack(root).monorepo).toBe(true);
  });

  it('detects packageManager from lockfiles when packageManager field is absent', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('pnpm-lock.yaml', 'lockfileVersion: 6.0\n');
    expect(detectStack(root).packageManager).toBe('pnpm');
  });

  it('detects node frameworks from dependencies (next/vite/express)', () => {
    write(
      'package.json',
      JSON.stringify({ name: 'x', dependencies: { next: '14', express: '4' } }),
    );
    const info = detectStack(root);
    expect(info.frameworks).toContain('next');
    expect(info.frameworks).toContain('express');
  });

  it('reports polyglot trees (node+python in the same root)', () => {
    write('package.json', JSON.stringify({ name: 'x' }));
    write('requirements.txt', 'fastapi\n');
    const info = detectStack(root);
    expect(info.languages).toEqual(expect.arrayContaining(['javascript', 'python']));
    expect(info.languages.sort()).toEqual(['javascript', 'python']);
  });

  it('packageManager from package.json#packageManager wins over lockfile detection', () => {
    write('package.json', JSON.stringify({ name: 'x', packageManager: 'pnpm@10.12.4' }));
    write('yarn.lock', '');
    expect(detectStack(root).packageManager).toBe('pnpm');
  });
});
