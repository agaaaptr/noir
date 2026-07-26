// SP-D validation fix — stack-aware ignore emission (TDD).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scaffold } from '../src/scaffold.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-ignore-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('stack-aware ignore emission', () => {
  it('blank project (unknown stack) → all 4 ignore files (backward compat)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    for (const f of ['.gitignore', '.dockerignore', '.npmignore', '.prettierignore']) {
      expect(existsSync(join(tmp, f))).toBe(true);
    }
  });

  it('Go project (go.mod + Dockerfile) → only .gitignore + .dockerignore; NO .npmignore/.prettierignore', async () => {
    writeFileSync(join(tmp, 'go.mod'), 'module example.com/x\n\ngo 1.22\n');
    writeFileSync(join(tmp, 'Dockerfile'), 'FROM golang:1.22\n');
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    expect(existsSync(join(tmp, '.gitignore'))).toBe(true);
    expect(existsSync(join(tmp, '.dockerignore'))).toBe(true);
    expect(existsSync(join(tmp, '.npmignore'))).toBe(false);
    expect(existsSync(join(tmp, '.prettierignore'))).toBe(false);
  });

  it('JS project (package.json, no Dockerfile) → .npmignore + .prettierignore; NO .dockerignore', async () => {
    writeFileSync(join(tmp, 'package.json'), '{"name":"x","version":"1.0.0"}');
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    expect(existsSync(join(tmp, '.gitignore'))).toBe(true);
    expect(existsSync(join(tmp, '.npmignore'))).toBe(true);
    expect(existsSync(join(tmp, '.prettierignore'))).toBe(true);
    expect(existsSync(join(tmp, '.dockerignore'))).toBe(false); // no Dockerfile
  });
});
