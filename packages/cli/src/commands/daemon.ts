// S9 — `noir daemon {start,stop,status,restart}`.
//
// Honest foreground daemon UX (S9 / spec §8). `noir daemon start` runs the
// daemon in-process FOREGROUND (it never silently forks): `ensureDaemonRunning`
// (from @noir-ai/daemon) either starts a fresh in-process HTTP server — whose
// listen handle + idle timer + SIGINT/SIGTERM handlers (installed inside
// `startHttpServer`) keep this CLI process alive until idle-stop or a signal —
// or reuses an already-healthy one and exits. Detached/socket-activated
// spawning is deferred, so `--detach` is wired (documented in `--help`) but
// refuses with exit 2 (USAGE) and a stable "tracked: v1.x" message rather than
// surprise-forking.
//
// Stream discipline (S9): `--json` emits the versioned `{ok,data}` envelope
// to stdout (the only stdout write); every human diagnostic goes to stderr via
// the centralized helpers. Exit codes follow the S9 contract: a missing/stale
// daemon record on `status` → exit 4 (DAEMON_DOWN); `--detach` → exit 2; an
// uninitialized project (`loadProjectInfo` throws) → exit 1 with the hint.

import { loadProjectInfo } from '@noir-ai/core';
import {
  clearDaemonRecord,
  ensureDaemonRunning,
  pidAlive,
  readDaemonRecord,
} from '@noir-ai/daemon';
import { type CliOptions, EXIT, fail, info, log, spinner } from '../output.js';

/** Options accepted by `daemon` sub-commands (the global flags only). */
export interface DaemonOptions extends CliOptions {}

/** `daemon start` adds the (recognized-but-refused) `--detach` flag. */
export interface DaemonStartOptions extends DaemonOptions {
  detach?: boolean;
}

/** v1 daemon mode is foreground-only; `--detach` is tracked for v1.x. */
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

// ---------------------------------------------------------------------------
// `noir daemon start` (foreground-honest; `--detach` → exit 2)
// ---------------------------------------------------------------------------
/**
 * Start the Noir daemon in the foreground (or report an already-running one).
 *
 * - `--detach` is recognized but NOT implemented in v1 → exit 2 (USAGE) with a
 *   stable "tracked: v1.x" message, so scripting against it fails honestly
 *   instead of surprise-forking.
 * - When `ensureDaemonRunning` STARTS a daemon, the in-process HTTP server
 *   keeps this process alive (foreground) until SIGINT/SIGTERM/idle-timeout;
 *   the function returns but the process does not exit. We deliberately do NOT
 *   call `ensured.stop()` — that would tear down the daemon we just started.
 * - When a healthy daemon is REUSED, this process reports it and exits.
 *
 * `--json` emits `{ok:true, data:{url,port,pid,mode,reused:false}}` to stdout
 * before the process blocks (so a `--json` caller still gets the one envelope).
 */
export async function daemonStart(opts: DaemonStartOptions): Promise<void> {
  if (opts.detach === true) {
    // Wired (appears in `--help`) but refused: detached/socket-activated
    // spawning is deliberate v0 debt (blueprint §9). Stable message + exit 2.
    fail(EXIT.USAGE, 'not implemented (tracked: v1.x)', opts);
  }

  const ds = spinner('Starting Noir daemon...', opts).start();
  const project = loadProjectInfo(process.cwd());
  const ensured = await ensureDaemonRunning({
    project,
    idleTimeoutSec: project.config.daemon.idleTimeoutSec,
  });

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
    info('noir daemon: foreground mode (backgrounding deferred to v1.x). Ctrl+C to stop.', opts);
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
  try {
    process.kill(rec.pid, 'SIGTERM');
    signalled = true;
  } catch (err) {
    // Process may have already exited; report but still clear the record below.
    errMsg = err instanceof Error ? err.message : String(err);
  } finally {
    clearDaemonRecord();
  }

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
    ds.warn(`Daemon (pid ${rec.pid}) could not be signalled: ${errMsg}`);
    info(`Noir daemon (pid ${rec.pid}) could not be signalled: ${errMsg}`, opts);
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
  const hs = spinner('Probing daemon health...', opts).start();
  let health: HealthBody | null = null;
  try {
    const res = await fetch(`http://127.0.0.1:${rec.port}/health`);
    if (res.status === 200) {
      health = (await res.json()) as HealthBody;
    }
  } catch {
    // ECONNREFUSED / DNS / timeout — treat as not-running below.
    health = null;
  }
  if (health?.ok !== true) {
    hs.fail('Daemon not responding');
    clearDaemonRecord();
    fail(
      EXIT.DAEMON_DOWN,
      'Noir daemon is not running (port unresponsive; stale record removed).',
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
    mode: MODE,
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
 * Stop any running daemon, then start a fresh foreground one.
 *
 * The stop sub-step is silenced (no separate envelope / message) so that under
 * `--json` a restart emits exactly ONE stdout envelope (the start result), and
 * so the human output's headline is the new daemon, not the torn-down old one.
 * `start` blocks foreground once it brings up a daemon, so `restart` blocks too
 * — the honest foreground behavior.
 */
export async function daemonRestart(opts: DaemonOptions): Promise<void> {
  // Force the stop to be quiet + non-JSON: its output would either duplicate
  // the start envelope (--json) or noise up the headline (human). The verbose
  // flag is forwarded so a `--verbose` caller still sees stop diagnostics.
  await daemonStop({ ...opts, json: false, quiet: true });
  await daemonStart(opts);
}
