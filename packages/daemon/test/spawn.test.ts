// D1/D2 — `spawnDetachedDaemon` tests. The detached spawn must NOT touch a real
// daemon or a real HTTP server: `node:child_process.spawn` and global `fetch`
// are stubbed at the module boundary. These pin the contract:
//   - the child is spawned with `detached:true`, `stdio:'ignore'`,
//     `windowsHide:true`, and `process.execPath` + the current bin entry
//     (`process.argv[1]`) for `daemon start --_detached-child`;
//   - `child.unref()` is called so the parent can exit;
//   - the port is read from the daemon record (which the child writes), and the
//     parent polls GET /health until it answers (fetch stub resolves once the
//     record is present);
//   - a timeout (record never appears / health never answers) rejects.
//
// The daemon record is isolated per vitest worker via NOIR_DAEMON_JSON (the same
// override the lifecycle module reads), so file-parallel runs never race on the
// global ~/.noir/daemon.json.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectInfo } from '@noir-ai/core';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-test-spawn-'));
process.env.NOIR_DAEMON_JSON = join(tmpRoot, 'daemon.json');

// Stub the child process at the module boundary — no real detached process is
// ever spawned, and the fake child records the spawn args for assertions.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({
  spawn: spawnMock,
}));

import { clearDaemonRecord, writeDaemonRecord } from '../src/lifecycle.js';
import { spawnDetachedDaemon } from '../src/spawn.js';

// Isolated project root so nothing touches a shared path.
const projectRoot = mkdtempSync(join(tmpdir(), 'noir-test-spawn-root-'));
const project: ProjectInfo = {
  id: 'spawn',
  name: 'spawn-demo',
  root: projectRoot,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/** A fake child handle: records the unref call, holds a pid. */
function fakeChild(pid: number) {
  return { pid, unref: vi.fn() };
}

beforeEach(() => {
  spawnMock.mockReset();
  clearDaemonRecord();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearDaemonRecord();
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('spawnDetachedDaemon', () => {
  it('spawns a detached, silent child and returns {pid, port} once /health answers', async () => {
    // The child "writes" its own record when spawned (mimics the child process
    // running `noir daemon start --_detached-child`, whose ensureDaemonRunning
    // writes the daemon record) — the parent then discovers the port.
    const port = 54321;
    spawnMock.mockImplementation((_exec: string, _argv: string[], _opts: unknown) => {
      writeDaemonRecord({ pid: 4321, port, startedAt: Date.now() });
      return fakeChild(4321);
    });
    // /health answers ok once the record (and thus the port) exists.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (url: RequestInfo | URL) => {
        const u = String(url);
        expect(u).toBe(`http://127.0.0.1:${port}/health`);
        return { status: 200 } as Response;
      });

    const result = await spawnDetachedDaemon({ project });
    expect(result).toEqual({ pid: 4321, port });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [exec, argv, opts] = spawnMock.mock.calls[0] as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(exec).toBe(process.execPath);
    // --cwd pins the project the detached child boots (it re-runs
    // loadProjectInfo(process.cwd())), so the child loads the SAME project the
    // parent resolved instead of whatever directory it inherits.
    expect(argv).toEqual([
      process.argv[1],
      'daemon',
      'start',
      '--_detached-child',
      '--cwd',
      project.root,
    ]);
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe('ignore');
    expect(opts.windowsHide).toBe(true);
    expect(opts.env).toMatchObject(process.env);
    const child = spawnMock.mock.results[0]?.value as { unref: () => void };
    expect(child.unref).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('throws a timeout error when the child never writes a record', async () => {
    spawnMock.mockImplementation(() => fakeChild(5555)); // record never written
    await expect(
      spawnDetachedDaemon(
        { project },
        { recordTimeoutMs: 60, healthTimeoutMs: 60, pollIntervalMs: 10 },
      ),
    ).rejects.toThrow(/timed out|timeout/i);
  });

  it('throws a timeout error when the record exists but /health never answers', async () => {
    spawnMock.mockImplementation((_exec: string, _argv: string[], _opts: unknown) => {
      writeDaemonRecord({ pid: 6666, port: 1, startedAt: Date.now() });
      return fakeChild(6666);
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    });
    await expect(
      spawnDetachedDaemon(
        { project },
        { recordTimeoutMs: 60, healthTimeoutMs: 60, pollIntervalMs: 10 },
      ),
    ).rejects.toThrow(/timed out|timeout/i);
    fetchSpy.mockRestore();
  });
});
