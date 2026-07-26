// SP-D follow-up — opt-in three-way managed-region merge (TDD).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTEXT_BLOCK, paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BRIEF_BLOCK } from '../src/manifest.js';
import { scaffold } from '../src/scaffold.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-merge-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Inject a user line just before the BRIEF region's end marker (i.e. INSIDE
 *  the managed region). */
function injectUserLine(noirMd: string): void {
  const content = readFileSync(noirMd, 'utf8');
  writeFileSync(
    noirMd,
    content.replace(BRIEF_BLOCK.end, `USER-EDITED-LINE\n${BRIEF_BLOCK.end}`),
    'utf8',
  );
}

describe('scaffold — mergeManagedRegions (SP-D, opt-in)', () => {
  it('init with merge writes .noir/ancestors.json', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio', mergeManagedRegions: true });
    expect(existsSync(join(tmp, '.noir', 'ancestors.json'))).toBe(true);
  });

  it('preserves a user edit inside a managed region across a re-emit (sync --merge)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio', mergeManagedRegions: true });
    const noirMd = paths.noirMd(tmp);
    injectUserLine(noirMd);
    // sync WITH merge: theirs === base (template unchanged) ⇒ keep ours (edited).
    await scaffold({ root: tmp, mode: 'sync', transport: 'stdio', mergeManagedRegions: true });
    expect(readFileSync(noirMd, 'utf8')).toContain('USER-EDITED-LINE');
  });

  it('default (no merge): no ancestor file; a user edit is strip-replaced', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    expect(existsSync(join(tmp, '.noir', 'ancestors.json'))).toBe(false);
    const noirMd = paths.noirMd(tmp);
    injectUserLine(noirMd);
    await scaffold({ root: tmp, mode: 'sync', transport: 'stdio' });
    expect(readFileSync(noirMd, 'utf8')).not.toContain('USER-EDITED-LINE');
  });

  it('multi-region (CLAUDE.md) merge preserves a user edit inside one region (sync --merge)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio', mergeManagedRegions: true });
    const claude = join(tmp, 'CLAUDE.md');
    // Inject a user line INSIDE the CONTEXT region (before its end marker).
    const content = readFileSync(claude, 'utf8');
    writeFileSync(
      claude,
      content.replace(CONTEXT_BLOCK.end, `USER-CTX-LINE\n${CONTEXT_BLOCK.end}`),
      'utf8',
    );
    // sync WITH merge: theirs (CONTEXT template) === base ⇒ keep ours (edited).
    await scaffold({ root: tmp, mode: 'sync', transport: 'stdio', mergeManagedRegions: true });
    expect(readFileSync(claude, 'utf8')).toContain('USER-CTX-LINE');
  });
});
