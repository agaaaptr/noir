import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artifactFileName, nextArtifactSequence, resolveArtifactPath } from '../src/artifacts.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-core-artifacts-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('artifactFileName', () => {
  it('assembles CODE-NNNN-taskId-slug', () => {
    expect(artifactFileName('spec', 1, { taskId: 't1', slug: 'add-login' })).toBe(
      'SP-0001-t1-add-login.md',
    );
    expect(artifactFileName('adr', 7, { slug: 'c3-standard' })).toBe('ADR-0007-c3-standard.md');
    expect(artifactFileName('intake', 10, { taskId: 't1' })).toBe('IN-0010-t1.md');
  });
});

describe('nextArtifactSequence', () => {
  it('is per-type independent and zero-padded', () => {
    const specsDir = join(root, '.noir', 'specs');
    mkdirSync(specsDir, { recursive: true });
    writeFileSync(join(specsDir, 'SP-0001-a-b.md'), 'x');
    writeFileSync(join(specsDir, 'SP-0003-a-b.md'), 'x');
    expect(nextArtifactSequence(root, 'spec')).toBe(4);
    // a different type starts at 1
    expect(nextArtifactSequence(root, 'plan')).toBe(1);
  });
});

describe('resolveArtifactPath', () => {
  it('reuses the existing artifact, else allocates the next sequence', () => {
    const p1 = resolveArtifactPath(root, 'spec', { taskId: 't1', slug: 's' });
    expect(p1.endsWith('SP-0001-t1-s.md')).toBe(true);
    mkdirSync(join(root, '.noir', 'specs'), { recursive: true });
    writeFileSync(p1, 'x');
    const p2 = resolveArtifactPath(root, 'spec', { taskId: 't1', slug: 's' });
    expect(p2).toBe(p1); // reuse, no SP-0002 minted
  });
});
