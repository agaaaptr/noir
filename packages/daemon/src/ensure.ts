import type { ProjectInfo } from '@noir-ai/core';
import { startHttpServer } from './http.js';
import { pidAlive } from './lifecycle.js';
import { retireLegacyDaemonRecord } from './migrate-legacy-record.js';
import { clearProjectDaemonRecord, readProjectDaemonRecord } from './project-record.js';

export interface EnsureResult {
  port: number;
  url: string;
  started: boolean;
  /**
   * Stops the daemon THIS call started. When `started` is true this closes the
   * in-process http server, clears this project's record, and clears the idle
   * timer. When `started` is false (a healthy daemon was reused) this is a
   * no-op: the reused daemon is owned by whichever process started it (in tests
   * that pid is `process.pid`, so killing it would be fatal) and must not be
   * torn down by a mere consumer.
   */
  stop: () => Promise<void>;
}

/** Bounded `/health` probe timeout — a stale record whose port is held by a
 *  blackhole socket (accepts TCP, never answers) must not hang every write
 *  command indefinitely. Matches `@noir-ai/cli`'s `PROBE_TIMEOUT_MS`. */
const HEALTH_PROBE_TIMEOUT_MS = 1500;

async function isHealthy(
  port: number,
  expectedPid?: number,
  expectedProjectId?: string,
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    if (expectedPid === undefined) return true;
    // PID-reuse guard (mirrors daemon.ts): on the reuse path, require the
    // responding daemon's OWN pid to match the recorded one — a foreign process
    // that recycled the pid and serves HTTP 200 must not be treated as OUR daemon.
    const body = (await res.json()) as { ok?: boolean; pid?: number; projectId?: string };
    if (body.ok !== true || body.pid !== expectedPid) return false;
    // Defence in depth: the record is already scoped to this project, but the
    // RESPONDING daemon's own /health projectId must match too. A daemon whose
    // store was baked for another project (or a hand-written record file that
    // predates the `projectId` field) is never reused.
    if (expectedProjectId !== undefined && body.projectId !== expectedProjectId) return false;
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(opts: {
  project: ProjectInfo;
  idleTimeoutSec: number;
  port?: number;
}): Promise<EnsureResult> {
  const { project } = opts;
  // Retire the pre-1.14 single global record first: a daemon from the previous
  // version still holds a write handle on this project's store, and the two
  // would fight over the single writer (spec 4.5). A no-op once retired.
  await retireLegacyDaemonRecord();

  // Scoped read: this can only ever return THIS project's record, so there is
  // no foreign record to detect, clear, or refuse. The three `wrongProject`
  // guards are gone because the condition they guarded is unrepresentable.
  const rec = readProjectDaemonRecord(project.id);
  if (rec && pidAlive(rec.pid) && (await isHealthy(rec.port, rec.pid, project.id))) {
    return {
      port: rec.port,
      url: `http://127.0.0.1:${rec.port}/mcp`,
      started: false,
      stop: async () => {
        /* no-op: reused daemon is owned elsewhere */
      },
    };
  }
  if (rec) clearProjectDaemonRecord(project.id); // stale — pid dead or /health failed

  const running = await startHttpServer({
    project: opts.project,
    idleTimeoutSec: opts.idleTimeoutSec,
    ...(opts.port !== undefined ? { port: opts.port } : {}),
  });
  return {
    port: running.port,
    url: `http://127.0.0.1:${running.port}/mcp`,
    started: true,
    stop: running.stop,
  };
}
