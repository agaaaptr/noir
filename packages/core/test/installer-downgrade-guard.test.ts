import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Drift + behavior guard for the shell-installer downgrade check.
 *
 * `noir install`/`migrate`/`update` refuse a pinned downgrade; the raw
 * installers (install.sh / install.ps1) must match, otherwise
 * `NOIR_VERSION=<older> curl|bash` would silently downgrade. The comparison is
 * a node one-liner embedded in both scripts; this test (a) asserts both scripts
 * still carry the guard, and (b) executes the exact node snippet from install.sh
 * against synthetic install.json records to pin the refuse/allow semantics.
 * Offline: no network.
 */
describe('installer downgrade guard', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const scripts = join(here, '..', '..', '..', 'scripts');
  const installSh = readFileSync(join(scripts, 'install.sh'), 'utf8');
  const installPs1 = readFileSync(join(scripts, 'install.ps1'), 'utf8');

  // The node one-liner passed to `-e`: its script contains no single quotes.
  const compareJs = installSh.match(/-e '([^']+)'/)?.[1] ?? '';

  /** Run the shipped comparison with an installed version + a requested pin. */
  function decide(installed: string, target: string): number {
    const dir = mkdtempSync(join(tmpdir(), 'noir-dg-'));
    const rec = join(dir, 'install.json');
    writeFileSync(rec, JSON.stringify({ method: 'native', version: installed }), 'utf8');
    const r = spawnSync(process.execPath, ['-e', compareJs], {
      env: { ...process.env, NOIR_INSTALL_JSON: rec, NOIR_TARGET: target },
      encoding: 'utf8',
    });
    rmSync(dir, { recursive: true, force: true });
    return r.status ?? 0;
  }

  it('both installers embed the downgrade guard (drift)', () => {
    expect(installSh).toContain('guard_downgrade');
    expect(installSh).toContain('refusing downgrade to');
    expect(installPs1).toContain('Guard-Downgrade');
    expect(installPs1).toContain('refusing downgrade to');
  });

  it('refuses a pinned downgrade (exit 2)', () => {
    expect(compareJs.length).toBeGreaterThan(0);
    expect(decide('1.19.2', '1.18.0')).toBe(2);
  });

  it('allows an upgrade (exit 0)', () => {
    expect(decide('1.18.0', '1.19.2')).toBe(0);
  });

  it('allows an equal version (exit 0)', () => {
    expect(decide('1.19.2', '1.19.2')).toBe(0);
  });

  it('skips when no version is recorded yet (exit 0)', () => {
    expect(decide('', '1.0.0')).toBe(0);
  });
});
