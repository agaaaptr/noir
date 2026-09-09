// Workspace daemon ensure + detached spawn — the workspace-aware counterparts to
// ensure.ts / spawn.ts. A workspace daemon is keyed by its own record file
// (`~/.noir/workspaces/<name>/daemon.json`), so reuse/health checks are scoped to
// ONE workspace and never collide with the project daemon record.
import { spawn } from 'node:child_process';
import type { ProjectInfo } from '@noir-ai/core';
import { pidAlive } from './lifecycle.js';
import { startWorkspaceHttpServer } from './workspace-http.js';
import { readWorkspaceDaemonRecord } from './workspace-record.js';

export interface WorkspaceEnsureResult {
  port: number;
  url: string;
  started: boolean;
  stop: () => Promise<void>;
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;

async function isWorkspaceHealthy(
  port: number,
  expectedPid: number | undefined,
  name: string,
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    const body = (await res.json()) as { ok?: boolean; pid?: number; workspace?: string };
    if (body.ok !== true || body.workspace !== name) return false;
    if (expectedPid !== undefined && body.pid !== expectedPid) return false;
    return true;
  } catch {
    return false;
  }
}

/** Ensure a workspace daemon is running for `name`; reuse a healthy one, else start. */
export async function ensureWorkspaceDaemonRunning(opts: {
  name: string;
  project: ProjectInfo;
  idleTimeoutSec: number;
}): Promise<WorkspaceEnsureResult> {
  const rec = readWorkspaceDaemonRecord(opts.name);
  if (rec && pidAlive(rec.pid) && (await isWorkspaceHealthy(rec.port, rec.pid, opts.name))) {
    return {
      port: rec.port,
      url: `http://127.0.0.1:${rec.port}/mcp`,
      started: false,
      stop: async () => {
        /* no-op: reused daemon is owned elsewhere */
      },
    };
  }
  const running = await startWorkspaceHttpServer({
    name: opts.name,
    project: opts.project,
    idleTimeoutSec: opts.idleTimeoutSec,
  });
  return {
    port: running.port,
    url: `http://127.0.0.1:${running.port}/mcp`,
    started: true,
    stop: running.stop,
  };
}

const DEFAULT_RECORD_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

async function waitFor(
  what: string,
  timeoutMs: number,
  pollMs: number,
  cond: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timed out waiting for ${what} (after ${timeoutMs}ms)`);
}

/** Spawn a detached `noir daemon start --workspace <name> --_detached-child` child. */
export async function spawnDetachedWorkspaceDaemon(opts: {
  name: string;
  project: ProjectInfo;
}): Promise<{ pid: number; port: number }> {
  const binEntry = process.argv[1];
  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    throw new Error('cannot spawn detached workspace daemon: missing bin entry (process.argv[1])');
  }
  const child = spawn(
    process.execPath,
    [
      binEntry,
      'daemon',
      'start',
      '--workspace',
      opts.name,
      '--_detached-child',
      '--cwd',
      opts.project.root,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();
  const pid = child.pid;
  if (typeof pid !== 'number') {
    throw new Error('failed to spawn detached workspace daemon (no pid)');
  }
  await waitFor(
    `workspace daemon record for pid ${pid}`,
    DEFAULT_RECORD_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS,
    () => {
      const rec = readWorkspaceDaemonRecord(opts.name);
      return rec?.pid === pid;
    },
  );
  const rec = readWorkspaceDaemonRecord(opts.name);
  if (!rec || rec.pid !== pid) {
    throw new Error(`timed out waiting for workspace daemon record for pid ${pid}`);
  }
  await waitFor(
    `workspace /health on port ${rec.port}`,
    DEFAULT_HEALTH_TIMEOUT_MS,
    DEFAULT_POLL_INTERVAL_MS,
    () => isWorkspaceHealthy(rec.port, pid, opts.name),
  );
  return { pid, port: rec.port };
}
