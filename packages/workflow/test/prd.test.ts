import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveArtifactPath } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPrd, writePrd } from '../src/artifacts.js';

describe('PRD artifacts', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'noir-prd-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writePrd writes .noir/prd/PRD-<NNNN>-<id>-<slug>.md with frontmatter + body', () => {
    writePrd(root, 't1', 'add-login', '# Problem\nUsers cannot log in.');
    const file = resolveArtifactPath(root, 'prd', { taskId: 't1', slug: 'add-login' });
    expect(existsSync(file)).toBe(true);
    const content = readFileSync(file, 'utf8');
    expect(content).toContain('kind: prd');
    expect(content).toContain('id: t1');
    expect(content).toContain('slug: add-login');
    expect(content).toContain('# Problem');
  });

  it('readPrd returns content when present, null when absent', () => {
    expect(readPrd(root, 't1', 'x')).toBeNull();
    writePrd(root, 't1', 'x', 'the body');
    expect(readPrd(root, 't1', 'x')?.includes('the body')).toBe(true);
  });
});
