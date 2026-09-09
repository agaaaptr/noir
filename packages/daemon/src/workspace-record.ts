// Workspace daemon record — the workspace-aware counterpart to
// `~/.noir/daemon.json`. Each workspace keeps its OWN record at
// `~/.noir/workspaces/<name>/daemon.json`, deliberately a DIFFERENT file from the
// project record so `noir daemon stop` / `ensureDaemonRunning` (which read/write
// the global record) can never adopt or stop a workspace daemon. The record
// carries the workspace NAME as its identity (a projectId is meaningless here —
// a workspace spans projects).
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, workspaceDir } from '@noir-ai/core';

export interface WorkspaceDaemonRecord {
  pid: number;
  port: number;
  startedAt: number;
  /** Workspace name — the identity this record belongs to. */
  workspace: string;
}

export function workspaceRecordPath(name: string): string {
  return join(workspaceDir(name), 'daemon.json');
}

export function readWorkspaceDaemonRecord(name: string): WorkspaceDaemonRecord | null {
  try {
    const raw = readFileSync(workspaceRecordPath(name), 'utf8');
    const rec = JSON.parse(raw) as WorkspaceDaemonRecord;
    if (typeof rec.pid === 'number' && typeof rec.port === 'number') return rec;
    return null;
  } catch {
    return null;
  }
}

export function writeWorkspaceDaemonRecord(name: string, rec: WorkspaceDaemonRecord): void {
  atomicWriteFile(workspaceRecordPath(name), `${JSON.stringify(rec)}\n`);
}

export function clearWorkspaceDaemonRecord(name: string): void {
  if (existsSync(workspaceRecordPath(name))) rmSync(workspaceRecordPath(name), { force: true });
}
