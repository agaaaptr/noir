// SP-D follow-up — ancestor store (TDD).
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ancestorsPath, readAncestors, writeAncestors } from '../src/ancestors.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-ancestors-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('ancestor store', () => {
  it('readAncestors returns {} when the file is absent (never throws)', () => {
    expect(readAncestors(tmp)).toEqual({});
  });
  it('write→read round-trips the map', () => {
    writeAncestors(tmp, { '.noir/NOIR.md::<!-- noir:brief begin -->': 'body1' });
    expect(readAncestors(tmp)).toEqual({
      '.noir/NOIR.md::<!-- noir:brief begin -->': 'body1',
    });
  });
  it('readAncestors returns {} for a corrupt file (never throws)', () => {
    writeAncestors(tmp, { k: 'v' });
    // Corrupt it.
    writeFileSync(ancestorsPath(tmp), '{ not json', 'utf8');
    expect(readAncestors(tmp)).toEqual({});
  });
  it('ancestorsPath is <root>/.noir/ancestors.json', () => {
    expect(ancestorsPath(tmp)).toBe(join(tmp, '.noir', 'ancestors.json'));
    expect(existsSync(ancestorsPath(tmp))).toBe(false);
  });
});
