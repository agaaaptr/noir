import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  clearDaemonRecord,
  daemonJsonPath,
  pidAlive,
  readDaemonRecord,
  writeDaemonRecord,
} from '../src/lifecycle.js';

// Isolate the global daemon.json per vitest worker (file-parallelism safe).
const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-test-lifecycle-'));
process.env.NOIR_DAEMON_JSON = join(tmpRoot, 'daemon.json');

afterAll(() => {
  clearDaemonRecord();
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterEach(() => {
  clearDaemonRecord();
});

describe('daemon lifecycle files', () => {
  it('round-trips a DaemonRecord in ~/.noir/daemon.json', () => {
    writeDaemonRecord({ pid: 4242, port: 5555, startedAt: 1 });
    const rec = readDaemonRecord();
    expect(rec).toEqual({ pid: 4242, port: 5555, startedAt: 1 });
  });
  it('clearDaemonRecord removes the file', () => {
    writeDaemonRecord({ pid: 1, port: 2, startedAt: 3 });
    clearDaemonRecord();
    expect(readDaemonRecord()).toBeNull();
  });
  it('pidAlive is true for the current process', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
  it('pidAlive is false for an unlikely pid', () => {
    expect(pidAlive(2_000_000)).toBe(false);
  });
  it('daemonJsonPath honors the NOIR_DAEMON_JSON override', () => {
    expect(daemonJsonPath()).toBe(process.env.NOIR_DAEMON_JSON);
  });
});
