import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from '@noir-ai/core';

export interface DaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
  /** Ownership: `foreground` (this CLI process) or `detached` (backgrounded via --detach). */
  mode?: 'foreground' | 'detached';
}

/** The env var `spawnDetachedDaemon` sets so the child writes a `detached` record. */
export const DAEMON_MODE_ENV = 'NOIR_DAEMON_MODE';

export function noirHome(): string {
  return join(homedir(), '.noir');
}

export function daemonJsonPath(): string {
  // NOIR_DAEMON_JSON override lets tests point each file's worker at an
  // isolated temp path (vitest file-parallelism would otherwise race on the
  // single global ~/.noir/daemon.json). Production leaves this unset.
  return process.env.NOIR_DAEMON_JSON ?? join(noirHome(), 'daemon.json');
}

export function readDaemonRecord(): DaemonRecord | null {
  try {
    const raw = readFileSync(daemonJsonPath(), 'utf8');
    const rec = JSON.parse(raw) as DaemonRecord;
    if (typeof rec.pid === 'number' && typeof rec.port === 'number') return rec;
    return null;
  } catch {
    return null;
  }
}

export function writeDaemonRecord(rec: DaemonRecord): void {
  mkdirSync(noirHome(), { recursive: true });
  atomicWriteFile(daemonJsonPath(), `${JSON.stringify(rec)}\n`);
}

export function clearDaemonRecord(): void {
  if (existsSync(daemonJsonPath())) rmSync(daemonJsonPath(), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
