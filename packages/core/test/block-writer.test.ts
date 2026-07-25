import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTEXT_BLOCK,
  commentStyleFor,
  readManagedBlock,
  stripManagedBlock,
  writeManagedRegion,
} from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const region = (body: string) => `${CONTEXT_BLOCK.begin}\n${body}\n${CONTEXT_BLOCK.end}\n`;

describe('blockWriter', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bw-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a fresh region into a missing file', () => {
    const f = join(dir, 'CLAUDE.md');
    writeManagedRegion(f, CONTEXT_BLOCK, region('@import ".noir/NOIR.md"'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('@import ".noir/NOIR.md"');
    expect(out.trimEnd().endsWith(CONTEXT_BLOCK.end)).toBe(true);
  });

  it('is idempotent: re-write replaces the old region, preserves user content', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, 'user header\n\n', 'utf8');
    writeManagedRegion(f, CONTEXT_BLOCK, region('OLD'));
    writeManagedRegion(f, CONTEXT_BLOCK, region('NEW'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('user header');
    expect(out).not.toContain('OLD');
    expect(out).toContain('NEW');
    expect((out.match(/<!-- noir:context begin -->/g) ?? []).length).toBe(1);
  });

  it('stripManagedBlock removes only the region', () => {
    const content = `keep\n${CONTEXT_BLOCK.begin}\nx\n${CONTEXT_BLOCK.end}\nalso keep\n`;
    expect(stripManagedBlock(content, CONTEXT_BLOCK)).toBe(`keep\nalso keep\n`);
  });

  it('readManagedBlock returns null when file missing', () => {
    expect(readManagedBlock(join(dir, 'nope.md'), CONTEXT_BLOCK)).toBeNull();
  });

  it('readManagedBlock returns the region when present', () => {
    const f = join(dir, 'CLAUDE.md');
    writeManagedRegion(f, CONTEXT_BLOCK, region('BODY'));
    expect(readManagedBlock(f, CONTEXT_BLOCK)?.includes('BODY')).toBe(true);
  });

  it('commentStyleFor: html for .md, hash for ignore/yml', () => {
    expect(commentStyleFor('CLAUDE.md')).toBe('html');
    expect(commentStyleFor('.gitignore')).toBe('hash');
    expect(commentStyleFor('.dockerignore')).toBe('hash');
    expect(commentStyleFor('config.yml')).toBe('hash');
  });
});
