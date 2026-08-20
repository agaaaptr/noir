// S9 — `noir daemon {start,stop,status,restart}`.
//
// Honest daemon UX (S9 / spec §8). `noir daemon start` runs the daemon either
// FOREGROUND or DETACHED, depending on flags:
//   - default (foreground): `ensureDaemonRunning` (from @noir-ai/daemon) starts
//     a fresh in-process HTTP server — whose listen handle + idle timer +
//     SIGINT/SIGTERM handlers (installed inside `startHttpServer`) keep this CLI
//     process alive until idle-stop or a signal — or reuses an already-healthy
//     one and exits.
//   - `--detach` (parent path, D1): `spawnDetachedDaemon` forks a detached child
//     `noir daemon start --_detached-child` (unref'd + silent stdio), waits for
//     the child's daemon record + `/health` to confirm it is serving, reports
//     `{mode:'detached', pid, port}`, and the PARENT exits — the child keeps the
//     daemon alive in the background.
//   - `--_detached-child` (child path, D2; hidden, set by the parent's spawn):
//     we ARE the detached child — run `ensureDaemonRunning` in-process (the HTTP
//     server keeps THIS process alive) and emit `{mode:'detached'}`. The child
//     is the SINGLE writer of the daemon record (its own pid), so the parent
//     discovers the port by polling that record.
//   Both detached paths guard double-spawn: an already-healthy daemon is reported
//   `{mode:'detached', reused:true}` and never spawned twice.
//
// Stream discipline (S9): `--json` emits the versioned `{ok,data}` envelope
// to stdout (the only stdout write); every human diagnostic goes to stderr via
// the centralized helpers. Exit codes follow the S9 contract: a missing/stale
// daemon record on `status` → exit 4 (DAEMON_DOWN); an uninitialized project
// (`loadProjectInfo` throws) → exit 1 with the hint.

import { loadProjectInfo, type ProjectInfo } from '@noir-ai/core';
import {
  clearDaemonRecord,
  ensureDaemonRunning,
  pidAlive,
  readDaemonRecord,
  spawnDetachedDaemon,
} from '@noir-ai/daemon';
import { PROBE_TIMEOUT_MS } from '../daemon-client.js';
import { type CliOptions, EXIT, fail, info, log, spinner } from '../output.js';

/** Options accepted by `daemon` sub-commands (the global flags only). */
export interface DaemonOptions extends CliOptions {}

/** `daemon start` adds the real `--detach` flag (D1) plus the hidden
 *  `--_detached-child` marker (D2) the detached child carries. */
export interface DaemonStartOptions extends DaemonOptions {
  /** `--detach`: parent path — fork a detached child and exit. */
  detach?: boolean;
  /** `--_detached-child` (hidden, reserved): we ARE the detached child. */
  detachChild?: boolean;
}

/** Human label for the detached mode in `status` output. */
const MODE = 'foreground' as const;

/** Shape of the `/health` body the daemon's HTTP server serves. */
interface HealthBody {
  ok?: boolean;
  pid?: number;
  uptimeSec?: number;
}

function formatUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return 'unknown';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

/** Best-effort `/health` probe (never throws). Bounded — a blackhole socket that
 *  accepts TCP but never answers must not hang `noir daemon start/status/stop`
 *  indefinitely. When `expectedPid` is given, the probe ALSO requires the
 *  responding daemon's own pid to match (the PID-reuse guard: a foreign process
 *  that recycled the recorded pid must never be signalled as "our daemon"). */
async function isHealthy(port: number, expectedPid?: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status !== 200) return false;
    if (expectedPid === undefined) return true;
    const body = (await res.json()) as HealthBody | undefined;
    return body?.ok === true && body.pid === expectedPid;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// `noir daemon start` (foreground default; `--detach` + `--_detached-child`)
// ---------------------------------------------------------------------------
/**
 * Start the Noir daemon — foreground by default, or detached via `--detach`.
 *
 * Three modes, chosen by the flags (all three guard double-spawn: an
 * already-healthy daemon is reported `{mode:'detached', reused:true}` / the
 * foreground `reused:true` envelope and never started twice):
 *
 * 1. `--_detached-child` (D2; hidden, only ever set by `spawnDetachedDaemon`'s
 *    child argv): we ARE the detached daemon. Run `ensureDaemonRunning`
 *    in-process — the started HTTP server + idle timer + signal handlers keep
 *    THIS process alive as the background daemon — emit `{mode:'detached'}`
 *    (or `{mode:'detached', reused:true}` when a healthy daemon is reused, in
 *    which case the redundant child exits) and return. The child is the SINGLE
 *    writer of the daemon record (its own pid), which is how the parent learns
 *    the port. We deliberately do NOT call `ensured.stop()` — that would undo
 *    the daemon we just started (or tear down a reused one owned elsewhere).
 * 2. `--detach` (D1; parent path): `spawnDetachedDaemon` forks the detached
 *    child, waits until the child's record + `/health` confirm it is serving,
 *    emits `{mode:'detached', pid, port}`, and the PARENT returns (and thus
 *    exits — it never blocks). Guard first: if a daemon is ALREADY healthy,
 *    report `{mode:'detached', reused:true}` and return WITHOUT spawning.
 * 3. Foreground (default): `ensureDaemonRunning` in-process. When it STARTS a
 *    daemon, the HTTP server keeps this process alive until
 *    SIGINT/SIGTERM/idle-timeout (the function returns but the process does not
 *    exit); when it REUSES a healthy daemon, this process reports and exits.
 *
 * `--json` emits the one envelope to stdout before the process blocks/returns.
 */
export async function daemonStart(opts: DaemonStartOptions): Promise<void> {
  // A throw from loadProjectInfo on an uninitialized project must route through
  // fail() — otherwise under --json stdout stays EMPTY (the raw error only
  // reaches stderr), violating the S9 `{ok:false}` envelope contract.
  let project: ProjectInfo;
  try {
    project = loadProjectInfo(process.cwd());
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }

  // D2 — detached CHILD path. The parent forked us via `--_detached-child`;
  // run the daemon in-process (the HTTP server keeps THIS process alive).
  if (opts.detachChild === true) {
    const child = await ensureDaemonRunning({
      project,
      idleTimeoutSec: project.config.daemon.idleTimeoutSec,
    });
    if (child.started) {
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ ok: true, data: { mode: 'detached' } })}\n`);
        return;
      }
      // The HTTP server + idle timer + signal handlers inside startHttpServer
      // keep this child process alive past `return` — it IS the daemon now.
      info('noir daemon: detached foreground. Ctrl+C to stop.', opts);
      log(`Noir daemon listening at ${child.url}`, opts);
      return;
    }
    // An already-healthy daemon was reused — this redundant child reports and
    // exits (the parent's double-spawn guard should have caught this, but the
    // child re-checks so two racing spawns can never start two daemons).
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { mode: 'detached', reused: true } })}\n`,
      );
      return;
    }
    info('Noir daemon already running; detached child exiting.', opts);
    return;
  }

  // D1 — `--detach` PARENT path. Fork a detached child and let it own the
  // daemon; the parent reports the backgrounded daemon and exits.
  if (opts.detach === true) {
    // Double-spawn guard: only spawn a child if no daemon is already healthy
    // (the child would merely reuse it and exit — a wasted detached process).
    const existing = readDaemonRecord();
    if (existing && pidAlive(existing.pid) && (await isHealthy(existing.port, existing.pid))) {
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({ ok: true, data: { mode: 'detached', reused: true } })}\n`,
        );
        return;
      }
      info(
        `Noir daemon already running at http://127.0.0.1:${existing.port}/mcp (detach not needed).`,
        opts,
      );
      return;
    }
    let spawned: Awaited<ReturnType<typeof spawnDetachedDaemon>>;
    try {
      spawned = await spawnDetachedDaemon({ project });
    } catch (err) {
      fail(
        EXIT.ERROR,
        `noir daemon start --detach failed: ${err instanceof Error ? err.message : String(err)}`,
        opts,
      );
    }
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { mode: 'detached', pid: spawned.pid, port: spawned.port } })}\n`,
      );
      return;
    }
    info(`Noir daemon started in the background (pid ${spawned.pid}, port ${spawned.port}).`, opts);
    // The parent returns (and exits); the detached child owns the daemon.
    return;
  }

  // Foreground (default) — run the daemon in-process.
  const ds = spinner('Starting Noir daemon...', opts).start();
  let ensured: Awaited<ReturnType<typeof ensureDaemonRunning>>;
  try {
    ensured = await ensureDaemonRunning({
      project,
      idleTimeoutSec: project.config.daemon.idleTimeoutSec,
    });
  } catch (err) {
    ds.fail('Daemon failed to start');
    fail(
      EXIT.ERROR,
      `noir daemon start failed: ${err instanceof Error ? err.message : String(err)}`,
      opts,
    );
  }

  if (ensured.started) {
    ds.succeed('Daemon started');
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          data: {
            url: ensured.url,
            port: ensured.port,
            pid: process.pid,
            mode: MODE,
            reused: false,
          },
        })}\n`,
      );
      return;
    }
    info('noir daemon: foreground mode. Ctrl+C to stop.', opts);
    log(`Noir daemon listening at ${ensured.url}`, opts);
    // NOTE: the started HTTP server + idle timer + signal handlers installed
    // inside startHttpServer keep this process alive past `return`. We
    // intentionally do NOT call ensured.stop(): that would undo the start.
    return;
  }

  // Reused an already-running daemon — this process exits after reporting.
  ds.succeed('Daemon already running');
  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({ ok: true, data: { url: ensured.url, port: ensured.port, reused: true } })}\n`,
    );
    return;
  }
  log(`Noir daemon already running at ${ensured.url}`, opts);
}

// ---------------------------------------------------------------------------
// `noir daemon stop`
// ---------------------------------------------------------------------------
/**
 * Stop the recorded daemon (SIGTERM its pid) and clear the record.
 *
 * Best-effort exit 0: a missing record ("not running") and a signal failure
 * both report and succeed, matching the pre-migration behavior. `--json` emits
 * `{ok:true, data:{running, stopped, pid?}}` to stdout.
 */
export async function daemonStop(opts: DaemonOptions): Promise<void> {
  const rec = readDaemonRecord();
  if (!rec) {
    if (opts.json === true) {
      process.stdout.write(
        `${JSON.stringify({ ok: true, data: { running: false, stopped: false } })}\n`,
      );
      return;
    }
    info('No Noir daemon is running.', opts);
    return;
  }

  const ds = spinner(`Stopping daemon (pid ${rec.pid})...`, opts).start();
  let signalled = false;
  let errMsg: string | undefined;
  // Guard PID reuse: only SIGTERM the recorded pid if it still answers as OUR
  // daemon on the recorded port. If the daemon crashed and the pid was recycled
  // by an unrelated process, a blind `process.kill(pid)` would signal an
  // innocent process — so probe `/health` first and clear the stale record if it
  // does not answer.
  const healthy = pidAlive(rec.pid) && (await isHealthy(rec.port, rec.pid));
  if (healthy) {
    try {
      process.kill(rec.pid, 'SIGTERM');
      signalled = true;
    } catch (err) {
      // Process may have already exited between the probe and the signal.
      errMsg = err instanceof Error ? err.message : String(err);
    }
  }
  clearDaemonRecord();

  if (opts.json === true) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        data: {
          running: signalled,
          stopped: signalled,
          pid: rec.pid,
          ...(errMsg !== undefined ? { error: errMsg } : {}),
        },
      })}\n`,
    );
    return;
  }
  if (signalled) {
    ds.succeed(`Stopped Noir daemon (pid ${rec.pid})`);
  } else {
    // Distinguish "not our daemon anymore" (pid-reuse guard declined to signal)
    // from "probe was healthy but the signal failed" (errMsg set).
    const reason =
      errMsg !== undefined
        ? errMsg
        : 'the recorded pid did not answer as our daemon (stale record cleared)';
    ds.warn(`Daemon (pid ${rec.pid}) could not be signalled: ${reason}`);
    info(`Noir daemon (pid ${rec.pid}) could not be signalled: ${reason}`, opts);
  }
}

// ---------------------------------------------------------------------------
// `noir daemon status`
// ---------------------------------------------------------------------------
/**
 * Report daemon liveness: read the record, confirm the pid is alive, and ping
 * `/health` for a live uptime. A missing/stale/unresponsive record maps to
 * exit 4 (DAEMON_DOWN) — the "probed by script" contract.
 *
 * `--json` emits `{ok:true, data:{running,pid,port,startedAt,uptimeSec,mode}}`
 * on success; failure goes through `fail()` (structured `{ok:false,error}` on
 * stdout under `--json`, plain message on stderr otherwise) with exit 4.
 */
export async function daemonStatus(opts: DaemonOptions): Promise<void> {
  const rec = readDaemonRecord();
  if (!rec) {
    fail(EXIT.DAEMON_DOWN, 'Noir daemon is not running (start with `noir daemon start`).', opts);
  }
  // `fail` returns `never` → TS narrows `rec` to DaemonRecord below.

  if (!pidAlive(rec.pid)) {
    clearDaemonRecord();
    fail(EXIT.DAEMON_DOWN, 'Noir daemon is not running (stale record removed).', opts);
  }

  // Live liveness probe: the daemon's HTTP server answers GET /health with
  // `{ok, pid, uptimeSec}`. A dead port / non-200 / unreachable host ⇒ stale.
  // Bounded like the other probes — a blackhole socket must not hang `noir
  // daemon status` (the "probed by script" exit-4 contract).
  const hs = spinner('Probing daemon health...', opts).start();
  let health: HealthBody | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.status === 200) {
      health = (await res.json()) as HealthBody;
    }
  } catch {
    // ECONNREFUSED / DNS / timeout — treat as not-running below.
    health = null;
  }
  // PID-reuse guard (same invariant as @noir-ai/daemon ensure.ts isHealthy +
  // this file's isHealthy): the responding /health must carry OUR recorded pid —
  // a missing or mismatched pid means a foreign process (or one that recycled
  // the pid) holds the port. Report stale, never "running" with the wrong
  // process's uptime. Distinguish "no health body at all" (port unresponsive)
  // from "body present but pid wrong" (foreign process).
  const pidMismatch = health !== null && typeof health?.pid === 'number' && health.pid !== rec.pid;
  if (health?.ok !== true || pidMismatch) {
    hs.fail('Daemon not responding');
    clearDaemonRecord();
    fail(
      EXIT.DAEMON_DOWN,
      pidMismatch
        ? 'Noir daemon is not running (pid mismatch — a foreign process holds the recorded port; stale record removed).'
        : 'Noir daemon is not running (port unresponsive; stale record removed).',
      opts,
    );
  }

  hs.succeed('Daemon healthy');

  // Prefer the daemon's own uptime count; fall back to the record's startedAt.
  const uptimeSec =
    typeof health?.uptimeSec === 'number'
      ? health.uptimeSec
      : Math.max(0, Math.floor((Date.now() - rec.startedAt) / 1000));
  const data = {
    running: true,
    pid: rec.pid,
    port: rec.port,
    startedAt: rec.startedAt,
    uptimeSec,
    // Honest ownership: the detached child writes `mode:'detached'`; anything
    // else (legacy record, foreground start) reports 'foreground'.
    mode: rec.mode ?? MODE,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(
    `Noir daemon: running (pid ${data.pid}, port ${data.port}, up ${formatUptime(uptimeSec)}, ${data.mode})`,
    opts,
  );
}

// ---------------------------------------------------------------------------
// `noir daemon restart`
// ---------------------------------------------------------------------------
/**
 * Stop any running daemon, then start a fresh one (foreground by default,
 * detached when `--detach` is forwarded through).
 *
 * The stop sub-step is silenced (no separate envelope / message) so that under
 * `--json` a restart emits exactly ONE stdout envelope (the start result), and
 * so the human output's headline is the new daemon, not the torn-down old one.
 * Foreground `start` blocks once it brings up a daemon, so a foreground restart
 * blocks too — the honest behavior; with `--detach` the parent exits after the
 * detached child is confirmed serving.
 */
export async function daemonRestart(opts: DaemonOptions): Promise<void> {
  // Force the stop to be quiet + non-JSON: its output would either duplicate
  // the start envelope (--json) or noise up the headline (human). The verbose
  // flag is forwarded so a `--verbose` caller still sees stop diagnostics.
  await daemonStop({ ...opts, json: false, quiet: true });
  await daemonStart(opts);
}
