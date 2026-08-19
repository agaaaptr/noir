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

async function isHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function ensureDaemonRunning(opts: {
  project: ProjectInfo;
  idleTimeoutSec: number;
}): Promise<EnsureResult> {
  const rec = readDaemonRecord();
  if (rec) {
    if (pidAlive(rec.pid) && (await isHealthy(rec.port))) {
      return {
        port: rec.port,
        url: `http://127.0.0.1:${rec.port}/mcp`,
        started: false,
        stop: async () => {
          /* no-op: reused daemon is owned elsewhere */
        },
      };
    }
    clearDaemonRecord(); // stale — pid dead or /health failed
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
