import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function spawnReadyChild(script: string): Promise<{ child: ChildProcess; pid: number }> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
  const [chunk] = await once(child.stdout as NonNullable<ChildProcess['stdout']>, 'data');
  const pid = child.pid;
  if (pid === undefined || !String(chunk).includes(READY_MARKER)) {
    child.kill('SIGKILL');
    throw new Error(`child did not report readiness (got ${JSON.stringify(String(chunk))})`);
  }
  return { child, pid };
}

describe('retireLegacyDaemonRecord', () => {
  it('is a no-op when no legacy record exists', async () => {
    await expect(retireLegacyDaemonRecord()).resolves.toBeUndefined();
  });

  it('removes a legacy record whose pid is dead', async () => {
    writeFileSync(legacy, JSON.stringify({ pid: 2 ** 30, port: 1, startedAt: Date.now() }));
    await retireLegacyDaemonRecord();
    expect(existsSync(legacy)).toBe(false);
  });

  it('SIGTERMs a live legacy daemon, waits, then removes the file', async () => {
    let child: ChildProcess | undefined;
    try {
      const spawned = await spawnReadyChild(plainDaemon);
      child = spawned.child;
      writeFileSync(legacy, JSON.stringify({ pid: spawned.pid, port: 1, startedAt: Date.now() }));
      await retireLegacyDaemonRecord();
      expect(existsSync(legacy)).toBe(false);
      // The wait is real: the daemon was signalled AND is actually gone.
      expect(() => process.kill(spawned.pid, 0)).toThrow();
      // A second invocation is a no-op (A4).
      await expect(retireLegacyDaemonRecord()).resolves.toBeUndefined();
    } finally {
      child?.kill('SIGKILL');
    }
  });

  it('refuses (rejects) and KEEPS the file when the daemon ignores SIGTERM', async () => {
    let child: ChildProcess | undefined;
    try {
      const spawned = await spawnReadyChild(sigtermIgnoringDaemon);
      child = spawned.child;
      writeFileSync(legacy, JSON.stringify({ pid: spawned.pid, port: 1, startedAt: Date.now() }));
      await expect(retireLegacyDaemonRecord({ exitTimeoutMs: 300 })).rejects.toThrow(
        /did not exit[\s\S]*kill \d+/,
      );
      expect(existsSync(legacy)).toBe(true); // left for the next attempt
    } finally {
      child?.kill('SIGKILL');
    }
  });

  it('skips the signal when startedAt predates this boot and still removes the file', async () => {
    let child: ChildProcess | undefined;
    try {
      const spawned = await spawnReadyChild(plainDaemon);
      child = spawned.child;
      // A live pid but a startedAt long before this boot is unreachable-stale:
      // after a reboot pids get recycled, so the pid must NOT be signalled.
      writeFileSync(legacy, JSON.stringify({ pid: spawned.pid, port: 1, startedAt: 1 }));
      await retireLegacyDaemonRecord();
      expect(existsSync(legacy)).toBe(false);
      // No signal was sent — the child is still alive.
      expect(() => process.kill(spawned.pid, 0)).not.toThrow();
    } finally {
      child?.kill('SIGKILL');
    }
  });

  it('removes a corrupt legacy record (bytes read but unparseable)', async () => {
    writeFileSync(legacy, '{not json');
    await retireLegacyDaemonRecord();
    expect(existsSync(legacy)).toBe(false);
  });

  it('refuses (rejects) and KEEPS the file when the record cannot be read', async () => {
    // A directory at the record path makes readFileSync throw (EISDIR) on every
    // platform — a portable stand-in for a root-owned / unreadable guard file.
    mkdirSync(legacy);
    try {
      await expect(retireLegacyDaemonRecord()).rejects.toThrow(
        /cannot read the legacy daemon record \(\w+\)/,
      );
      expect(existsSync(legacy)).toBe(true); // left for the next attempt
    } finally {
      rmSync(legacy, { recursive: true, force: true });
    }
  });
});
