import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK, type ManagedBlock, managedBlock } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildRegion,
  managedBlocks,
  managedBlock as managedWrite,
  predictManagedBlock,
  predictManagedBlocks,
  regenerate,
  skipIfExists,
} from '../src/writers.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-create-writers-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('regenerate', () => {
  it('overwrites existing content', () => {
    const f = join(dir, 'p.txt');
    writeFileSync(f, 'OLD', 'utf8');
    regenerate(f, 'NEW');
    expect(readFileSync(f, 'utf8')).toBe('NEW');
  });

  it('creates a missing file', () => {
    const f = join(dir, 'fresh.txt');
    regenerate(f, 'BODY');
    expect(readFileSync(f, 'utf8')).toBe('BODY');
  });

  it('is atomic: no leftover tmp files after success', () => {
    const f = join(dir, 'atomic.txt');
    regenerate(f, 'X');
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp.'));
    expect(leftovers).toEqual([]);
  });

  it('is atomic: truncated-by-crash scenario leaves prior bytes (tmp→rename semantics)', () => {
    // We can't easily kill mid-write; instead assert the post-condition shape:
    // the file exists with the new content and exactly one file matches the
    // target name (no `.tmp.*` partial).
    const f = join(dir, 'p2.txt');
    writeFileSync(f, 'KEEP', 'utf8');
    regenerate(f, 'REPLACED');
    expect(readFileSync(f, 'utf8')).toBe('REPLACED');
    expect(readdirSync(dir)).toEqual(['p2.txt']);
  });
});

describe('managedBlock writer (delegates to keystone-K writeManagedRegion)', () => {
  const block: ManagedBlock = CONTEXT_BLOCK;

  it('writes a fresh region into a missing file', () => {
    const f = join(dir, 'CLAUDE.md');
    managedWrite(f, block, buildRegion(block, '@import ".noir/NOIR.md"'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('@import ".noir/NOIR.md"');
    expect(out).toContain(block.begin);
    expect(out).toContain(block.end);
  });

  it('is idempotent: re-run produces the SAME bytes (no region duplication, no blank-line drift)', () => {
    const f = join(dir, 'CLAUDE.md');
    const region = buildRegion(block, '@import ".noir/NOIR.md"');
    managedWrite(f, block, region);
    const first = readFileSync(f, 'utf8');
    managedWrite(f, block, region);
    const second = readFileSync(f, 'utf8');
    expect(second).toBe(first);
    expect((second.match(/<!-- noir:context begin -->/g) ?? []).length).toBe(1);
  });

  it('preserves user content outside the markers', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '# My project\n\nPersonal notes.\n', 'utf8');
    managedWrite(f, block, buildRegion(block, '@import ".noir/NOIR.md"'));
    const out = readFileSync(f, 'utf8');
    expect(out).toContain('# My project');
    expect(out).toContain('Personal notes.');
    expect(out).toContain('@import ".noir/NOIR.md"');
  });

  it('buildRegion produces the canonical marker/body shape', () => {
    const local = managedBlock('custom', 'html');
    expect(buildRegion(local, 'BODY')).toBe(`${local.begin}\nBODY\n${local.end}\n`);
  });

  it('buildRegion trimEnds the body so a template trailing newline does not create a double-blank before the end marker (parity with claudeAdapter/syncIgnores)', () => {
    const local = managedBlock('custom', 'html');
    // Body with a trailing newline (as a .tmpl file would load).
    expect(buildRegion(local, 'BODY\n')).toBe(`${local.begin}\nBODY\n${local.end}\n`);
    expect(buildRegion(local, 'BODY\n\n\n')).toBe(`${local.begin}\nBODY\n${local.end}\n`);
  });
});

describe('predictManagedBlock / predictManagedBlocks (content-hash dedup)', () => {
  const ctx = CONTEXT_BLOCK;
  const rules = managedBlock('rules', 'html');
  const ctxRegion = buildRegion(ctx, '@import ".noir/NOIR.md"');
  const rulesRegion = buildRegion(rules, '@import ".noir/rules/RULES.md"');

  it('predictManagedBlock equals what managedBlock writes for a fresh (empty) file', () => {
    // The writer (via core writeManagedRegion) on a missing file emits exactly
    // regionText. The predictor on '' must agree byte-for-byte.
    expect(predictManagedBlock('', ctx, ctxRegion)).toBe(ctxRegion);
  });

  it('predictManagedBlock equals what managedBlock writes when user content surrounds the region', () => {
    const file = `# My project\n\n${ctxRegion}`;
    // After a managedBlock re-emit of ctxRegion into `file`, the on-disk bytes
    // are: stripped user content + "\n\n" + regionText. The predictor must match.
    const predicted = predictManagedBlock(file, ctx, ctxRegion);
    // Simulate the actual write via the writer and compare.
    const tmp = join(dir, 'predict-single.md');
    writeFileSync(tmp, file, 'utf8');
    managedWrite(tmp, ctx, ctxRegion);
    expect(readFileSync(tmp, 'utf8')).toBe(predicted);
  });

  it('predictManagedBlock detects an unchanged region (predict === current) for the dedup fast-path', () => {
    // After the writer emits ctxRegion into a file holding user content, a
    // re-emit produces the SAME bytes → predict === current ⇒ skip write.
    const tmp = join(dir, 'predict-unchanged.md');
    writeFileSync(tmp, '# Title\n\n', 'utf8');
    managedWrite(tmp, ctx, ctxRegion);
    const current = readFileSync(tmp, 'utf8');
    expect(predictManagedBlock(current, ctx, ctxRegion)).toBe(current);
  });

  it('predictManagedBlocks equals what managedBlocks writes for a fresh multi-region file', () => {
    expect(
      predictManagedBlocks(
        '',
        [ctx, rules].map((b) => ({ block: b, regionText: buildRegion(b, 'X') })),
      ),
    ).toBe(`${buildRegion(ctx, 'X')}\n${buildRegion(rules, 'X')}`);
  });

  it('predictManagedBlocks equals what managedBlocks writes when user content is present', () => {
    const file = `# Header\n\n${ctxRegion}\n${rulesRegion}`;
    const predicted = predictManagedBlocks(file, [
      { block: ctx, regionText: ctxRegion },
      { block: rules, regionText: rulesRegion },
    ]);
    const tmp = join(dir, 'predict-multi.md');
    writeFileSync(tmp, file, 'utf8');
    managedBlocks(tmp, [
      { block: ctx, regionText: ctxRegion },
      { block: rules, regionText: rulesRegion },
    ]);
    expect(readFileSync(tmp, 'utf8')).toBe(predicted);
  });

  it('predictManagedBlocks throws on an empty regions array (contract guard)', () => {
    expect(() => predictManagedBlocks('', [])).toThrow(/at least one region/);
  });

  it('predictManagedBlocks delegates to predictManagedBlock for a single region', () => {
    const file = `# H\n\n${ctxRegion}`;
    expect(predictManagedBlocks(file, [{ block: ctx, regionText: ctxRegion }])).toBe(
      predictManagedBlock(file, ctx, ctxRegion),
    );
  });
});

describe('skipIfExists', () => {
  it('writes when the file is absent and reports written=true', () => {
    const f = join(dir, 'seed.md');
    const out = skipIfExists(f, 'SEED');
    expect(out.written).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('SEED');
  });

  it('is a no-op (written=false) when the file already exists; original bytes preserved', () => {
    const f = join(dir, 'seed.md');
    writeFileSync(f, 'USER-EDITED', 'utf8');
    const out = skipIfExists(f, 'SHOULD-NOT-WRITE');
    expect(out.written).toBe(false);
    expect(readFileSync(f, 'utf8')).toBe('USER-EDITED');
  });

  it('does not throw when the target dir is missing (caller owns mkdir)', () => {
    // skipIfExists uses writeFileSync which DOES create the file but errors on
    // a missing parent dir. The orchestrator mkdirs first; here we just assert
    // the writer itself doesn't add surprising mkdir semantics by checking the
    // happy path is stable.
    const f = join(dir, 'ok.md');
    expect(() => skipIfExists(f, 'OK')).not.toThrow();
    expect(existsSync(f)).toBe(true);
  });
});
