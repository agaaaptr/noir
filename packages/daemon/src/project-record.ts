// Per-project daemon record — the project-scoped counterpart to
// `~/.noir/daemon.json`. Mirrors `workspace-record.ts`: one file per identity,
// so no code path can read, adopt, or clear another project's record.
// That is what removes the `wrongProject` guards in ensure.ts / commands/daemon.ts
// (spec §4.3) — the bug is structural, so the fix is structural.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, noirHome } from '@noir-ai/core';

/** Directory holding per-project records. `NOIR_DAEMON_DIR` isolates tests. */
export const NOIR_DAEMON_DIR_ENV = 'NOIR_DAEMON_DIR';

export interface ProjectDaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
  /** Ownership: `foreground` (this CLI process) or `detached` (via --detach). */
  mode?: 'foreground' | 'detached';
  /** The identity this record belongs to (cf. `workspace` on a workspace record). */
  projectId: string;
}

export function projectRecordDir(): string {
  return process.env[NOIR_DAEMON_DIR_ENV]?.trim() || join(noirHome(), 'daemons');
}

export function projectRecordPath(projectId: string): string {
  return join(projectRecordDir(), `${projectId}.json`);
}

export function readProjectDaemonRecord(projectId: string): ProjectDaemonRecord | null {
  try {
    const rec = JSON.parse(
      readFileSync(projectRecordPath(projectId), 'utf8'),
    ) as ProjectDaemonRecord;
    if (typeof rec.pid === 'number' && typeof rec.port === 'number') return rec;
    return null;
  } catch {
    return null;
  }
}

export function writeProjectDaemonRecord(projectId: string, rec: ProjectDaemonRecord): void {
  mkdirSync(projectRecordDir(), { recursive: true });
  atomicWriteFile(projectRecordPath(projectId), `${JSON.stringify(rec)}\n`);
}

export function clearProjectDaemonRecord(projectId: string): void {
  const p = projectRecordPath(projectId);
  if (existsSync(p)) rmSync(p, { force: true });
}

/** Every project record on this machine — for `noir daemon status --all` + doctor. */
export function listProjectDaemonRecords(): Array<{ projectId: string; rec: ProjectDaemonRecord }> {
  let names: string[];
  try {
    names = readdirSync(projectRecordDir());
  } catch {
    return []; // dir absent — no daemon has ever run
  }
  const out: Array<{ projectId: string; rec: ProjectDaemonRecord }> = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const projectId = name.slice(0, -'.json'.length);
    const rec = readProjectDaemonRecord(projectId);
    if (rec) out.push({ projectId, rec });
  }
  return out;
}
