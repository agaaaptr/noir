import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectCommands, detectEntryPoints, renderBaseline } from '../src/baseline.js';
import { detectStack } from '../src/stack-detect.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-baseline-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('detectCommands', () => {
  it('surfaces canonical package.json scripts', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest run', lint: 'biome check' } }),
      'utf8',
    );
    expect(detectCommands(root)).toEqual({ build: 'tsc', test: 'vitest run', lint: 'biome check' });
  });

  it('falls back to Makefile targets', () => {
    writeFileSync(join(root, 'Makefile'), 'build:\n\tgo build\ntest:\n\tgo test\n', 'utf8');
    expect(detectCommands(root)).toEqual({ build: 'make build', test: 'make test' });
  });

  it('returns empty for a bare dir', () => {
    expect(detectCommands(root)).toEqual({});
  });
});

describe('detectEntryPoints', () => {
  it('finds known entry files', () => {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), '', 'utf8');
    expect(detectEntryPoints(root)).toEqual(['src/index.ts']);
  });
});

describe('renderBaseline', () => {
  it('renders stack, commands, and entry points', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        dependencies: { next: '^14' },
        devDependencies: { typescript: '^5' },
        scripts: { build: 'next build' },
      }),
      'utf8',
    );
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'index.ts'), '', 'utf8');
    const stack = detectStack(root);
    const out = renderBaseline(stack, detectCommands(root), detectEntryPoints(root));
    expect(out).toContain('**Stack:** typescript (next)');
    expect(out).toContain('`build`: `next build`');
    expect(out).toContain('src/index.ts');
  });

  it('still renders a minimal block for an empty dir', () => {
    const out = renderBaseline(detectStack(root), {}, []);
    expect(out).toContain('**Stack:** unknown');
    expect(out).toContain('**Package manager:** none');
  });
});
