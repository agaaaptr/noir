import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearDaemonRecord,
  daemonJsonPath,
  pidAlive,
  readDaemonRecord,
  writeDaemonRecord,
} from '../src/lifecycle.js';

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
  it('daemonJsonPath lives under ~/.noir', () => {
    expect(daemonJsonPath()).toBe(join(homedir(), '.noir', 'daemon.json'));
  });
});
