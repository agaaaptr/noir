// Regression: the co-owned host files (CLAUDE.md / AGENTS.md / GEMINI.md and
// the ignore files) are files the USER also edits. Both the core managed-region
// writer (`writeManagedRegion`) and the create multi-region writer
// (`managedBlocks`) used to rewrite them with a plain truncating `writeFileSync`,
// so an interrupted write (power loss, a full disk, a killed process) could leave
// the user's own file half-written on disk. They now go through
// `atomicWriteFile` (write a temp sibling, then rename over the target), so the
// destination holds either the old bytes or the new bytes — never a mix.
//
// The interruption is simulated by arming a one-shot failure on the write to a
// specific destination path. Two hooks are needed because the interruption can
// land in two real windows:
//   - the in-place write: the destination is truncated before any byte lands,
//     then the write fails (what the old plain write did); and
//   - the atomic swap: the temp file is written but the rename never happens.
// Either way the test asserts the destination still holds the ORIGINAL bytes.
// Which hook fires also carries information: an atomic writer reaches the
// destination only through the rename, so a writer that throws from the rename
// hook is demonstrably staging a temp file first rather than writing in place.
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK, RULES_BLOCK, writeManagedRegion } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildRegion, managedBlocks } from '../src/writers.js';

// Hoisted so the `node:fs` mock factory (also hoisted) can read it.
const interrupt = vi.hoisted(() => ({ target: null as string | null }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realWrite = actual.writeFileSync as unknown as (
    path: string,
    data: unknown,
    options?: unknown,
  ) => void;
  const realRename = actual.renameSync as unknown as (from: string, to: string) => void;
  return {
    ...actual,
    writeFileSync: vi.fn((p: string, data?: unknown, options?: unknown) => {
      if (interrupt.target !== null && p === interrupt.target) {
        // A plain in-place write opens the destination with 'w' (truncating it)
        // before any byte is written. Model the crash at exactly that point:
        // the file is emptied, then the write fails.
        realWrite(interrupt.target, '');
        throw new Error('simulated interruption: the in-place write was cut off');
      }
      return realWrite(p, data, options);
    }),
    renameSync: vi.fn((from: string, to: string) => {
      if (interrupt.target !== null && to === interrupt.target) {
        // The atomic writer staged its temp file and was about to swap it in
        // when the process died.
        throw new Error('simulated interruption: the swap never happened');
      }
      return realRename(from, to);
    }),
  };
});

const contextRegion = buildRegion(CONTEXT_BLOCK, '@import ".noir/NOIR.md"');
const rulesRegion = buildRegion(RULES_BLOCK, '@import ".noir/rules/RULES.md"');

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noir-atomic-host-'));
  interrupt.target = null;
});
afterEach(() => {
  interrupt.target = null;
  rmSync(dir, { recursive: true, force: true });
});

describe('interrupted write leaves the original file intact', () => {
  it('core writeManagedRegion does not destroy a co-owned file when the write is cut off', () => {
    const f = join(dir, 'CLAUDE.md');
    const original = '# My project\n\nPersonal notes.\n';
    writeFileSync(f, original, 'utf8');

    interrupt.target = f;
    expect(() => writeManagedRegion(f, CONTEXT_BLOCK, contextRegion)).toThrow(
      /simulated interruption/,
    );

    // The user's own file is untouched — no half-written CLAUDE.md.
    expect(readFileSync(f, 'utf8')).toBe(original);
  });

  it('create managedBlocks does not destroy a co-owned file when the write is cut off', () => {
    const f = join(dir, 'CLAUDE.md');
    const original = '# My project\n\nPersonal notes.\n';
    writeFileSync(f, original, 'utf8');

    interrupt.target = f;
    expect(() =>
      managedBlocks(f, [
        { block: CONTEXT_BLOCK, regionText: contextRegion },
        { block: RULES_BLOCK, regionText: rulesRegion },
      ]),
    ).toThrow(/simulated interruption/);

    // The user's own file is untouched — no half-written CLAUDE.md.
    expect(readFileSync(f, 'utf8')).toBe(original);
  });
});

describe('success path writes the same bytes and preserves the existing mode', () => {
  it('core writeManagedRegion emits byte-identical output and keeps the file mode', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '# My project\n\nPersonal notes.\n', 'utf8');
    chmodSync(f, 0o600);

    writeManagedRegion(f, CONTEXT_BLOCK, contextRegion);

    expect(readFileSync(f, 'utf8')).toBe(
      '# My project\n\nPersonal notes.\n\n<!-- noir:context begin -->\n@import ".noir/NOIR.md"\n<!-- noir:context end -->\n',
    );
    expect(statSync(f).mode & 0o777).toBe(0o600);
    // The temp file was renamed away, not left behind.
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  });

  it('create managedBlocks emits byte-identical output and keeps the file mode', () => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '# My project\n\n', 'utf8');
    chmodSync(f, 0o640);

    managedBlocks(f, [
      { block: CONTEXT_BLOCK, regionText: contextRegion },
      { block: RULES_BLOCK, regionText: rulesRegion },
    ]);

    expect(readFileSync(f, 'utf8')).toBe(
      '# My project\n\n<!-- noir:context begin -->\n@import ".noir/NOIR.md"\n<!-- noir:context end -->\n\n<!-- noir:rules begin -->\n@import ".noir/rules/RULES.md"\n<!-- noir:rules end -->\n',
    );
    expect(statSync(f).mode & 0o777).toBe(0o640);
    // The temp file was renamed away, not left behind.
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  });
});
