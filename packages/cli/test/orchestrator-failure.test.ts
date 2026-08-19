// Failure-path coverage for the host orchestrator: API-error assistant events
// must be flagged (so run.ts never streams them as answers), and runHost must
// surface isError + errorText from the stream so the CLI can fail honestly.
// Uses small offline fixture hosts — no real claude, no network.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeStreamEvent, runHost } from '../src/orchestrator.js';

const fix = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

const hasZsh = ((): boolean => {
  try {
    return spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();

describe('normalizeStreamEvent — API-error assistant events', () => {
  it('flags an assistant event that is an API error message (is_api_error_message + error category)', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] },
      error: 'authentication_failed',
      is_api_error_message: true,
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBe(true);
  });

  it('flags an assistant event carrying an error category even without the boolean flag', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'rate limited' }] },
      error: 'rate_limit',
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBe(true);
  });

  it('leaves clean assistant events unflagged', () => {
    const e = normalizeStreamEvent({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'hello' }] },
    });
    expect(e?.kind).toBe('assistant');
    if (e?.kind === 'assistant') expect(e.isError).toBeUndefined();
  });
});

describe('runHost — failure surfacing (fixture hosts)', () => {
  it('surfaces isError + errorText for an auth-error host that exits 1', async () => {
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-auth-error.sh'),
    });
    expect(r.exitCode).toBe(1);
    expect(r.isError).toBe(true);
    expect(r.errorText).toContain('Not logged in · Please run /login');
  });

  it('reports isError=true even when the host exits 0 (is_error is the signal, not the exit code)', async () => {
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: fix('host-exit0-error.sh'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(true);
  });

  it('reports isError=false and no errorText for a clean run', async () => {
    const r = await runHost({ host: 'claude', prompt: 'x', customBinary: fix('host-ok.sh') });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.errorText).toBeUndefined();
  });

  it('reports a signal-killed host (no result event, code null) as a failure, not exit 0', async () => {
    const r = await runHost({ host: 'claude', prompt: 'x', customBinary: fix('host-killed.sh') });
    expect(r.isError).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(r.errorText).toContain('terminated by signal');
  });
});

describe('runHost — shell-bridge ENOENT fallback (zsh alias)', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // A custom binary that is a zsh alias (invisible to spawn()) must be resolved
  // through the user's interactive shell and produce the host stream-json.
  it.skipIf(!hasZsh)('bridges a zsh alias to the real host fixture', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-host-'));
    writeFileSync(join(dir, '.zshrc'), `alias myhost="${fix('host-ok.sh')}"\n`, { mode: 0o644 });
    const r = await runHost({
      host: 'claude',
      prompt: 'x',
      customBinary: 'myhost',
      env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: dir, HOME: dir },
    });
    expect(r.exitCode).toBe(0);
    expect(r.isError).toBe(false);
    expect(r.eventCount).toBeGreaterThan(0); // stream-json was parsed
  });

  it.skipIf(!hasZsh)('an unresolvable name still surfaces the original ENOENT', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noir-bridge-miss-'));
    writeFileSync(join(dir, '.zshrc'), '', { mode: 0o644 });
    await expect(
      runHost({
        host: 'claude',
        prompt: 'x',
        customBinary: 'no-such-command-abc',
        env: { ...process.env, SHELL: '/bin/zsh', ZDOTDIR: dir, HOME: dir },
      }),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
