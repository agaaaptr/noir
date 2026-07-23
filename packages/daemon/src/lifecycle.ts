import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
}

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
  writeFileSync(daemonJsonPath(), `${JSON.stringify(rec)}\n`, 'utf8');
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
