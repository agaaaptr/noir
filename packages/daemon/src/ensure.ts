import type { ProjectInfo } from '@noir-ai/core';
import { startHttpServer } from './http.js';
import { clearDaemonRecord, pidAlive, readDaemonRecord } from './lifecycle.js';

export interface EnsureResult {
  port: number;
  url: string;
  started: boolean;
  /**
   * Stops the daemon THIS call started. When `started` is true this closes the
   * in-process http server, clears `daemon.json`, and clears the idle timer.
   * When `started` is false (a healthy daemon was reused) this is a no-op: the
   * reused daemon is owned by whichever process started it (in tests that pid is
   * `process.pid`, so killing it would be fatal) and must not be torn down by a
   * mere consumer.
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
    // CROSS-PROJECT isolation: the daemon's store is baked in for its start-time
    // project. Reuse only when the /health projectId matches the expected one
    // (and an absent projectId — a pre-1.12 daemon — is never trusted).
    if (expectedProjectId !== undefined && body.projectId !== expectedProjectId) return false;
    return true;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(opts: {
  project: ProjectInfo;
  idleTimeoutSec: number;
}): Promise<EnsureResult> {
  const { project } = opts;
  const rec = readDaemonRecord();
  if (rec) {
    // Cross-project isolation: a daemon serves the store baked in at its start
    // time. A record for ANOTHER project (a 1.12+ record with a mismatched
    // projectId) is cleared so we start a fresh daemon for THIS project — two
    // daemons serve DIFFERENT DBs, so no single-writer violation.
    //
    // A PRE-1.12 record (no projectId) is REUSED on a pid+port match: we cannot
    // project-verify it, and reusing it is safer than clearing it + starting a
    // SECOND writer on the same .noir/store/<projectId>.db (the old daemon would
    // still be running and holding that DB open — a single-writer violation).
    const wrongProject = rec.projectId !== undefined && rec.projectId !== project.id;
    if (!wrongProject) {
      const expectProject = rec.projectId === undefined ? undefined : project.id;
      if (pidAlive(rec.pid) && (await isHealthy(rec.port, rec.pid, expectProject))) {
        return {
          port: rec.port,
          url: `http://127.0.0.1:${rec.port}/mcp`,
          started: false,
          stop: async () => {
            /* no-op: reused daemon is owned elsewhere */
          },
        };
      }
    }
    clearDaemonRecord(); // stale — pid dead or /health failed, or a wrong-project record
  }
  const running = await startHttpServer({
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
