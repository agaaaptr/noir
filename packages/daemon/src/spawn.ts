// D1/D2 — real `noir daemon start --detach`. `spawnDetachedDaemon` detaches a
// child `noir daemon start --_detached-child` process (detached + unref'd +
// silent stdio, so the parent can exit and the child outlives it) and waits
// until that child's daemon record + `/health` confirm it is serving. Returns
// `{pid, port}` so the parent can report the backgrounded daemon and exit.
//
// The child is the SINGLE writer of the daemon record (its in-process
// `ensureDaemonRunning` → `startHttpServer` writes `~/.noir/daemon.json` with
// the child's own pid), so the parent discovers the port by polling the record
// for `rec.pid === child.pid` — never by racing a write of its own.

import { spawn } from 'node:child_process';
import type { ProjectInfo } from '@noir-ai/core';
import { DAEMON_MODE_ENV, readDaemonRecord } from './lifecycle.js';

/**
 * Polling knobs. Production uses the 5s defaults; tests shrink them so a
 * timeout path fails fast instead of sleeping out the real deadlines.
 */
export interface SpawnTiming {
  /** How long to wait for the child's daemon record (ms). */
  recordTimeoutMs?: number;
  /** How long to wait for the child's `/health` to answer (ms). */
  healthTimeoutMs?: number;
  /** How often to poll between checks (ms). */
  pollIntervalMs?: number;
}

const DEFAULT_RECORD_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

/** Poll `condition` until it resolves truthy or `timeoutMs` elapses. */
async function waitFor(
  what: string,
  timeoutMs: number,
  pollIntervalMs: number,
  condition: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`timed out waiting for ${what} (after ${timeoutMs}ms)`);
}

/** True once `GET /health` on `port` answers 200 (best-effort, never throws).
 *  Bounded — a blackhole socket that accepts TCP but never answers must not
 *  hang the detach-wait loop past `healthTimeoutMs`. */
async function healthOk(port: number, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

/**
 * Spawn a detached `noir daemon start --_detached-child` child and wait for it
 * to become healthy. Resolves `{pid, port}` once the child's daemon record is
 * visible AND `/health` answers — the parent can then report and exit. Throws
 * (with a `timed out` message) if the record or `/health` never appears.
 */
export async function spawnDetachedDaemon(
  opts: { project: ProjectInfo },
  timing: SpawnTiming = {},
): Promise<{ pid: number; port: number }> {
  const recordTimeoutMs = timing.recordTimeoutMs ?? DEFAULT_RECORD_TIMEOUT_MS;
  const healthTimeoutMs = timing.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const pollIntervalMs = timing.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // `process.argv[1]` is the `noir` bin entry in production (the child argv must
  // re-invoke the SAME entry). Under `noUncheckedIndexedAccess` it is typed
  // `string | undefined`, and an `undefined` slot breaks every `spawn` overload
  // (collapsing `child` to `never`), so narrow it to `string` explicitly — the
  // bin entry is guaranteed present when the CLI is actually running.
  const binEntry = process.argv[1];
  if (typeof binEntry !== 'string' || binEntry.length === 0) {
    throw new Error('cannot spawn detached daemon child: missing bin entry (process.argv[1])');
  }

  // The hidden `--_detached-child` flag tells the child it IS the detached daemon
  // (run the daemon in-process, don't spawn again). `--cwd` pins the project the
  // child boots (it re-runs `loadProjectInfo(process.cwd())`), so the child loads
  // the SAME project the parent resolved — regardless of the child's inherited
  // working directory. `--json` is deliberately NOT forwarded — the child's
  // stdout is ignored anyway.
  const child = spawn(
    process.execPath,
    [binEntry, 'daemon', 'start', '--_detached-child', '--cwd', opts.project.root],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      // `NOIR_DAEMON_MODE=detached` makes the child write a `mode:'detached'`
      // daemon record, so `noir daemon status` reports honest ownership.
      env: { ...process.env, [DAEMON_MODE_ENV]: 'detached' },
    },
  );
  child.unref(); // the parent exits; the child keeps running

  const pid = child.pid;
  if (typeof pid !== 'number') {
    throw new Error('failed to spawn detached daemon child (no pid)');
  }

  // The child writes the daemon record itself (with ITS pid) when its
  // in-process server binds — poll until that record appears.
  await waitFor(
    `daemon record for pid ${pid}`,
    recordTimeoutMs,
    pollIntervalMs,
    () => readDaemonRecord()?.pid === pid,
  );
  const rec = readDaemonRecord();
  if (!rec || rec.pid !== pid) {
    throw new Error(
      `timed out waiting for daemon record for pid ${pid} (after ${recordTimeoutMs}ms)`,
    );
  }

  // Record exists — the port is real only once the server answers /health.
  await waitFor(`daemon /health on port ${rec.port}`, healthTimeoutMs, pollIntervalMs, () =>
    healthOk(rec.port, healthTimeoutMs),
  );

  return { pid, port: rec.port };
}
