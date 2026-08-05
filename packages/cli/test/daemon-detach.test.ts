// D1/D2 — `noir daemon start --detach` behavior tests. These pin the detached
// path WITHOUT starting a real daemon or spawning a real child:
//   - `spawnDetachedDaemon` + `ensureDaemonRunning` (from @noir-ai/daemon) are
//     mocked at the module boundary so neither a child process nor an in-process
//     HTTP server is ever spun up;
//   - the record helpers (`readDaemonRecord`/`pidAlive`/`writeDaemonRecord`) stay
//     REAL so the parent path's double-spawn guard is exercised honestly against
//     a live `/health` on an ephemeral port.
//
// Covered here:
//   - `--detach` → parent path: calls `spawnDetachedDaemon`, emits the
//     `{mode:'detached', pid, port}` envelope under `--json`, and returns (the
//     parent EXITS — it never blocks);
//   - `--detach` double-spawn guard: when a daemon is ALREADY healthy, the parent
//     reports `{mode:'detached', reused:true}` and returns WITHOUT spawning;
//   - `--_detached-child` → child path: `ensureDaemonRunning` runs in-process
//     (the HTTP server keeps the child alive) and emits `{mode:'detached'}` under
//     `--json`; when the child discovers an already-running daemon
//     (`started:false`) it reports reused and returns (the redundant child exits).
//
// The daemon record is isolated per vitest worker via NOIR_DAEMON_JSON (the same
// override the daemon module reads), so file-parallel runs never race on the
// global ~/.noir/daemon.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY spawnDetachedDaemon + ensureDaemonRunning (so the detached paths never
// spawn a real child or start a real in-process server); the record helpers stay
// real so the double-spawn guard can be tested honestly.
vi.mock('@noir-ai/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@noir-ai/daemon')>();
  return {
    ...actual,
    ensureDaemonRunning: vi.fn(),
    spawnDetachedDaemon: vi.fn(),
  };
});

import { ensureDaemonRunning, spawnDetachedDaemon, writeDaemonRecord } from '@noir-ai/daemon';
import { daemonStart } from '../src/commands/daemon.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-daemon-detach-test-'));
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

// daemonStart calls `loadProjectInfo(process.cwd())` before the detach branch,
// so seed a minimal valid project in a temp root and chdir into it.
let startRoot: string;
let origCwd: string;
beforeEach(() => {
  vi.mocked(ensureDaemonRunning).mockReset();
  vi.mocked(spawnDetachedDaemon).mockReset();
  startRoot = mkdtempSync(join(tmpdir(), 'noir-daemon-detach-start-'));
  origCwd = process.cwd();
  mkdirSync(paths.noirDir(startRoot), { recursive: true });
  writeFileSync(paths.projectId(startRoot), 'daemon-detach-test-project\n', 'utf8');
  writeFileSync(paths.config(startRoot), 'host: claude\nmode: full\n', 'utf8');
  process.chdir(startRoot);
});

afterEach(() => {
  process.chdir(origCwd);
  rmSync(startRoot, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('noir daemon start --detach (parent path)', () => {
  it('spawns the detached child, emits the detached envelope under --json, and returns', async () => {
    vi.mocked(spawnDetachedDaemon).mockResolvedValue({ pid: 4321, port: 54321 });
    const r = await run(() => daemonStart({ detach: true, json: true }));
    expect(r.err).toBeUndefined();
    expect(spawnDetachedDaemon).toHaveBeenCalledTimes(1);
    expect(spawnDetachedDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        // spawn.ts's signature is `opts:{project:ProjectInfo}` — the project
        // rides inside the wrapper, so assert the nested id.
        project: expect.objectContaining({ id: 'daemon-detach-test-project' }),
      }),
    );
    // The parent EMITS then EXITS — no blocking message, single envelope.
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ mode: 'detached', pid: 4321, port: 54321 });
  });

  it('double-spawn guard: reports already-running and returns WITHOUT spawning', async () => {
    // A healthy daemon record → the parent reports reuse and skips the spawn
    // (the spawned child would only reuse it and exit — no double-spawn).
    const server: Server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(404).end();
      }
    });
    const port: number = await new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        resolve(addr.port);
      });
    });
    try {
      writeDaemonRecord({ pid: process.pid, port, startedAt: Date.now() });
      const r = await run(() => daemonStart({ detach: true, json: true }));
      expect(r.err).toBeUndefined();
      expect(spawnDetachedDaemon).not.toHaveBeenCalled();
      const envelope = JSON.parse(r.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toEqual({ mode: 'detached', reused: true });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('human path prints a backgrounded message to stderr and returns', async () => {
    vi.mocked(spawnDetachedDaemon).mockResolvedValue({ pid: 4321, port: 54321 });
    const r = await run(() => daemonStart({ detach: true }));
    expect(r.err).toBeUndefined();
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/background/);
    expect(r.stderr).toMatch(/54321/);
  });
});

describe('noir daemon start --_detached-child (child path)', () => {
  it('runs ensureDaemonRunning in-process and emits {mode:detached} under --json', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65000/mcp',
      port: 65000,
      started: true,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({ detachChild: true, json: true }));
    expect(r.err).toBeUndefined();
    // The child path never calls spawnDetachedDaemon (that is the PARENT's job).
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ mode: 'detached' });
  });

  it('child path that reuses an existing daemon (started:false) reports reused + returns', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65001/mcp',
      port: 65001,
      started: false,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({ detachChild: true, json: true }));
    expect(r.err).toBeUndefined();
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ mode: 'detached', reused: true });
  });

  it('child path human output reports the detached foreground listen', async () => {
    vi.mocked(ensureDaemonRunning).mockResolvedValue({
      url: 'http://127.0.0.1:65002/mcp',
      port: 65002,
      started: true,
      stop: async () => {},
    });
    const r = await run(() => daemonStart({ detachChild: true }));
    expect(r.err).toBeUndefined();
    expect(spawnDetachedDaemon).not.toHaveBeenCalled();
    expect(r.stderr).toMatch(/Ctrl\+C to stop/);
  });
});
