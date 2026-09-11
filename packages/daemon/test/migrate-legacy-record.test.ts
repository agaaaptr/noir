import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-legacy-'));
const legacy = join(tmpRoot, 'daemon.json');
process.env.NOIR_DAEMON_JSON = legacy;

const { retireLegacyDaemonRecord } = await import('../src/migrate-legacy-record.js');

// The child prints "ready" only after its script has fully evaluated, so a test
// can await the handshake before signalling it. Without this the parent's
// SIGTERM (sent ~2ms after spawn) lands while node is still booting — before
// SIGTERM-handler state exists — and the child dies from the DEFAULT
// disposition, which defeats both live-daemon tests.
const READY_MARKER = 'ready';
const plainDaemon = `console.log(${JSON.stringify(READY_MARKER)});setInterval(()=>{},1000)`;
const sigtermIgnoringDaemon =
  `process.on("SIGTERM",()=>{});console.log(${JSON.stringify(READY_MARKER)});` +
  'setInterval(()=>{},1000)';

async function spawnReadyChild(script: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout as NonNullable<ChildProcess['stdout']>, 'data');
  return child;
}

describe('retireLegacyDaemonRecord', () => {
  it('is a no-op when no legacy record exists', async () => {
    await expect(retireLegacyDaemonRecord()).resolves.toBeUndefined();
  });

  it('removes a legacy record whose pid is dead', async () => {
    writeFileSync(legacy, JSON.stringify({ pid: 2 ** 30, port: 1, startedAt: 1 }));
    await retireLegacyDaemonRecord();
    expect(existsSync(legacy)).toBe(false);
  });

  it('SIGTERMs a live legacy daemon, waits, then removes the file', async () => {
    const child = await spawnReadyChild(plainDaemon);
    try {
      writeFileSync(legacy, JSON.stringify({ pid: child.pid, port: 1, startedAt: 1 }));
      await retireLegacyDaemonRecord();
      expect(existsSync(legacy)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('refuses (rejects) and KEEPS the file when the daemon ignores SIGTERM', async () => {
    const child = await spawnReadyChild(sigtermIgnoringDaemon);
    try {
      writeFileSync(legacy, JSON.stringify({ pid: child.pid, port: 1, startedAt: 1 }));
      await expect(retireLegacyDaemonRecord({ exitTimeoutMs: 300 })).rejects.toThrow(
        /did not exit/,
      );
      expect(existsSync(legacy)).toBe(true); // left for the next attempt
    } finally {
      child.kill('SIGKILL');
    }
  });
});
