// S9 — `noir daemon {start,stop,status,restart}` behavior tests.
//
// Covers the foreground-honest UX without starting a real Noir daemon:
//   - `start --detach` → exit 2 (USAGE) "not implemented (tracked: v1.x)"
//     (including the --json error envelope on stdout)
//   - `start` foreground/reused paths via a mocked `ensureDaemonRunning`
//   - `status` exit-code contract: no record / stale pid / port unresponsive
//     → exit 4; a live `/health` → exit 0 + pid/uptime/mode
//   - `stop` best-effort exit 0 (no record / un-signallable)
//
// The daemon record is isolated per vitest worker via NOIR_DAEMON_JSON (the same
// override the daemon module reads), so file-parallel runs never race on the
// global ~/.noir/daemon.json.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { clearDaemonRecord, writeDaemonRecord } from '@noir-ai/daemon';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY ensureDaemonRunning (so start's foreground/reused paths don't spin a
// real server); every other export stays real — status/stop need the genuine
// record helpers + pidAlive + fetch.
vi.mock('@noir-ai/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noir-ai/daemon')>();
  return {
    ...actual,
    ensureDaemonRunning: vi.fn(),
  };
});

import { ensureDaemonRunning } from '@noir-ai/daemon';
import { daemonStart, daemonStatus, daemonStop } from '../src/commands/daemon.js';
import { EXIT, inferExitCode } from '../src/output.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-daemon-test-'));
process.env.NOIR_DAEMON_JSON = join(tmpRoot, 'daemon.json');

/** Capture stdout/stderr around `fn`, returning the streams + any thrown value. */
async function run(
  fn: () => Promise<void>,
): Promise<{ stdout: string; stderr: string; err: unknown }> {
  const out: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    errChunks.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { stdout: out.join(''), stderr: errChunks.join(''), err };
}

/** A pid guaranteed to be dead (a child that has already exited). */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return typeof res.pid === 'number' ? res.pid : 999_999;
}

beforeEach(() => {
  vi.mocked(ensureDaemonRunning).mockReset();
  clearDaemonRecord();
});

afterEach(() => {
  clearDaemonRecord();
});

afterAll(() => {
  // Remove the temp dir ONCE after all tests (per-test removal would break the
  // next test's writeDaemonRecord, which writes into tmpRoot/daemon.json).
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('noir daemon start', () => {
  // The success paths (foreground / reused / --json envelope) need an
  // INITIALIZED project: daemonStart calls `loadProjectInfo(process.cwd())`
  // before ensureDaemonRunning. Seed a minimal valid config in a temp root and
  // chdir into it. The `not initialized` test below chdirs to its own empty dir
  // to assert the failure path; the `--detach` tests fail before loadProjectInfo.
  let daemonStartRoot: string;
  let daemonStartOrigCwd: string;
  beforeEach(() => {
    daemonStartRoot = mkdtempSync(join(tmpdir(), 'noir-daemon-start-'));
    daemonStartOrigCwd = process.cwd();
    mkdirSync(paths.noirDir(daemonStartRoot), { recursive: true });
    writeFileSync(paths.projectId(daemonStartRoot), 'daemon-test-project\n', 'utf8');
    writeFileSync(paths.config(daemonStartRoot), 'host: claude\nmode: full\n', 'utf8');
    process.chdir(daemonStartRoot);
  });
  afterEach(() => {
    process.chdir(daemonStartOrigCwd);
    rmSync(daemonStartRoot, { recursive: true, force: true });
  });

  it('--detach → exit 2 with the stable "tracked: v1.x" message', async () => {
    const r = await run(() => daemonStart({ detach: true }));
    expect(r.err).toBeDefined();
    expect(inferExitCode(r.err)).toBe(EXIT.USAGE);
    expect(r.stderr).toContain('not implemented (tracked: v1.x)');
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
  });

  it('--detach under --json emits the structured error envelope on stdout (exit 2)', async () => {
    const r = await run(() => daemonStart({ detach: true, json: true }));
    expect(inferExitCode(r.err)).toBe(EXIT.USAGE);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe(EXIT.USAGE);
    expect(envelope.error.message).toMatch(/not implemented \(tracked: v1\.x\)/);
  });

  it('not initialized → exit 1 (loadProjectInfo throws before ensure)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'noir-daemon-noinit-'));
    const orig = process.cwd();
    try {
      process.chdir(cwd);
      const r = await run(() => daemonStart({}));
      expect(r.err).toBeDefined();
      expect(inferExitCode(r.err)).toBe(EXIT.ERROR);
      // daemonStart propagates loadProjectInfo's throw directly — bin's
      // handleError surfaces it to stderr in production; at the unit level the
      // hint lives on the thrown error, so assert it there (not stderr).
      expect(r.err instanceof Error ? r.err.message : String(r.err)).toMatch(/not initialized/i);
    } finally {
      process.chdir(orig);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('foreground start (started:true) prints the honest message to stderr', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65000/mcp',
      port: 65000,
      started: true,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({}));
    expect(r.err).toBeUndefined();
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/foreground mode/);
    expect(r.stderr).toMatch(/Ctrl\+C to stop/);
    expect(r.stderr).toMatch(/http:\/\/127\.0\.0\.1:65000\/mcp/);
  });

  it('foreground start --json emits the envelope with mode foreground', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65001/mcp',
      port: 65001,
      started: true,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({ json: true }));
    expect(r.err).toBeUndefined();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual(
      expect.objectContaining({
        url: 'http://127.0.0.1:65001/mcp',
        port: 65001,
        mode: 'foreground',
        reused: false,
      }),
    );
    expect(envelope.data.pid).toBe(process.pid);
  });

  it('reused daemon (started:false) reports + exits without blocking', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65002/mcp',
      port: 65002,
      started: false,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({ json: true }));
    expect(r.err).toBeUndefined();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data.reused).toBe(true);
  });
});

describe('noir daemon status — exit-code contract', () => {
  it('no record → exit 4 (DAEMON_DOWN)', async () => {
    clearDaemonRecord();
    const r = await run(() => daemonStatus({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stderr).toMatch(/not running/);
  });

  it('no record under --json → structured daemon-down envelope (exit 4)', async () => {
    clearDaemonRecord();
    const r = await run(() => daemonStatus({ json: true }));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe(EXIT.DAEMON_DOWN);
  });

  it('stale record (pid dead) → clears the record + exit 4', async () => {
    writeDaemonRecord({ pid: deadPid(), port: 1, startedAt: Date.now() });
    const r = await run(() => daemonStatus({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stderr).toMatch(/stale record removed/);
  });

  it('live pid but /health unreachable → clears the record + exit 4', async () => {
    // Current pid is alive, but nothing listens on a closed port → /health fails.
    writeDaemonRecord({ pid: process.pid, port: 1, startedAt: Date.now() });
    const r = await run(() => daemonStatus({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stderr).toMatch(/stale record removed/);
  });

  it('healthy daemon (record + live /health) → exit 0 + pid/port/mode payload', async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, uptimeSec: 42 }));
      } else {
        res.writeHead(404).end();
      }
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      writeDaemonRecord({ pid: process.pid, port, startedAt: Date.now() });
      const r = await run(() => daemonStatus({ json: true }));
      expect(r.err).toBeUndefined();
      const envelope = JSON.parse(r.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual(
        expect.objectContaining({
          running: true,
          pid: process.pid,
          port,
          mode: 'foreground',
          uptimeSec: 42,
        }),
      );
      // Human path renders the same facts on stderr.
      const human = await run(() => daemonStatus({}));
      expect(human.err).toBeUndefined();
      expect(human.stderr).toMatch(/running \(pid/);
      expect(human.stderr).toMatch(/foreground/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      clearDaemonRecord();
    }
  });
});

describe('noir daemon stop — best-effort exit 0', () => {
  it('no record → exit 0 "not running"', async () => {
    clearDaemonRecord();
    const r = await run(() => daemonStop({}));
    expect(r.err).toBeUndefined();
    expect(r.stderr).toMatch(/No Noir daemon is running/);
  });

  it('no record under --json → envelope {running:false, stopped:false}', async () => {
    clearDaemonRecord();
    const r = await run(() => daemonStop({ json: true }));
    expect(r.err).toBeUndefined();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.data).toEqual({ running: false, stopped: false });
  });

  it('stale record (dead pid) → clears + exit 0 with the could-not-signal note', async () => {
    const pid = deadPid();
    writeDaemonRecord({ pid, port: 9, startedAt: Date.now() });
    const r = await run(() => daemonStop({}));
    expect(r.err).toBeUndefined();
    expect(r.stderr).toMatch(/could not be signalled/);
  });
});
