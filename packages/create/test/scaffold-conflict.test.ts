// SP-C — regenerate conflict resolution (TDD). The engine gains an onConflict
// hook + conflictPolicy so a hand-edited `regenerate` file (.mcp.json,
// AGENTS.md) is no longer silently clobbered on sync / init --force / --upgrade.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ConflictContext, type ConflictResolution, scaffold } from '../src/scaffold.js';

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noir-conflict-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** First init (seeds scaffold-version), then re-emit with --force to exercise
 *  the regenerate conflict path on a hand-edited .mcp.json. */
async function reemit(
  opts: Parameters<typeof scaffold>[0] = {},
): Promise<ReturnType<typeof scaffold>> {
  return scaffold({ root: tmp, mode: 'init', transport: 'stdio', force: true, ...opts });
}

describe('scaffold — regenerate conflict resolution (SP-C)', () => {
  it('default conflictPolicy=overwrite: a differing regenerate file is replaced (backward compatible)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    const tpl = readFileSync(mcp, 'utf8'); // snapshot the template bytes
    writeFileSync(mcp, 'USER-EDIT'); // differs from the template
    const res = await reemit(); // default overwrite, no onConflict
    expect(res.written).toContain('.mcp.json');
    expect(readFileSync(mcp, 'utf8')).toBe(tpl); // clobbered WITH the template (not garbage)
    expect(existsSync(`${mcp}.local`)).toBe(false); // NOT a rename regression
  });

  it('conflictPolicy=preserve: a differing regenerate file is kept (not clobbered)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(mcp, 'USER-EDIT');
    const res = await reemit({ conflictPolicy: 'preserve' });
    expect(readFileSync(mcp, 'utf8')).toBe('USER-EDIT'); // preserved
    expect(res.skipped).toContain('.mcp.json');
  });

  it('onConflict receives the context (relPath/existing/proposed) and the resolution drives the outcome', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(mcp, 'USER-EDIT');
    const seen: ConflictContext[] = [];
    const onConflict = vi.fn((ctx: ConflictContext): ConflictResolution => {
      seen.push(ctx);
      return 'rename';
    });
    const res = await reemit({ onConflict });
    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(seen[0]?.relPath).toBe('.mcp.json');
    expect(seen[0]?.existing).toBe('USER-EDIT');
    expect(typeof seen[0]?.proposed).toBe('string');
    // rename: the user's file moved aside (.local), the template written in place.
    expect(readFileSync(mcp, 'utf8')).not.toBe('USER-EDIT');
    expect(readFileSync(mcp, 'utf8')).toBe(seen[0]?.proposed); // template bytes, exactly
    expect(existsSync(`${mcp}.local`)).toBe(true);
    expect(readFileSync(`${mcp}.local`, 'utf8')).toBe('USER-EDIT');
    expect(res.written).toContain('.mcp.json');
  });

  it('onConflict=duplicate: template written to <path>.noir, user file untouched', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(mcp, 'USER-EDIT');
    await reemit({ onConflict: () => 'duplicate' });
    expect(readFileSync(mcp, 'utf8')).toBe('USER-EDIT'); // untouched
    expect(existsSync(`${mcp}.noir`)).toBe(true); // template alongside
  });

  it('onConflict=preserve: user file untouched, reported skipped', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(mcp, 'USER-EDIT');
    const res = await reemit({ onConflict: () => 'preserve' });
    expect(readFileSync(mcp, 'utf8')).toBe('USER-EDIT');
    expect(res.skipped).toContain('.mcp.json');
    expect(res.written).not.toContain('.mcp.json');
  });

  it('onConflict=cancel: ABORTS the whole scaffold (throws; user file untouched)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(mcp, 'USER-EDIT');
    await expect(reemit({ onConflict: () => 'cancel' })).rejects.toThrow(/cancel/i);
    expect(readFileSync(mcp, 'utf8')).toBe('USER-EDIT'); // not clobbered
  });

  it('onConflict=rename is idempotent + never clobbers a prior .local (review fix)', async () => {
    await scaffold({ root: tmp, mode: 'init', transport: 'stdio' });
    const mcp = join(tmp, '.mcp.json');
    writeFileSync(`${mcp}.local`, 'PRIOR-BACKUP'); // a previous rename's aside
    writeFileSync(mcp, 'USER-EDIT');
    const res = await reemit({ onConflict: () => 'rename' });
    // Prior backup preserved (NOT clobbered); the new aside went to .local.1.
    expect(readFileSync(`${mcp}.local`, 'utf8')).toBe('PRIOR-BACKUP');
    expect(readFileSync(`${mcp}.local.1`, 'utf8')).toBe('USER-EDIT');
    expect(res.skipped).toContain('.mcp.json.local.1');
  });
});
