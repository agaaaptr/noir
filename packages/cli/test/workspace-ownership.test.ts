// Ownership before signalling: `noir workspace stop` must never signal a process
// that is not the workspace's daemon, and `status`/`list` must not report a stale
// record as a live daemon.
//
// Every test here runs offline. The record points at a pid that is genuinely
// alive — a real child process this test spawns — while the port answers `/health`
// as something else (another workspace, or a different pid). That is exactly the
// recycled-pid situation the guard exists for. The liveness answer comes from a
// real local HTTP server, so the probe's fetch, its JSON parse and its bounded
// timeout all run for real.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureWorkspaceRegistry } from '@noir-ai/core';
import { pidAlive, readWorkspaceDaemonRecord, writeWorkspaceDaemonRecord } from '@noir-ai/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceList, workspaceStatus, workspaceStop } from '../src/commands/workspace.js';
import { EXIT } from '../src/output.js';

const WORKSPACE = 'demo';

let home: string;
let servers: Server[];
let children: ChildProcess[];

/** Spawn a real, long-lived process and return it — the "live pid" a stale record points at. */
function spawnLiveProcess(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  children.push(child);
  if (typeof child.pid !== 'number') throw new Error('failed to spawn the live fixture process');
  return child;
}

/** Start a real local server that answers `/health` with the given identity. */
async function startHealthServer(identity: { pid: number; workspace: string }): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ...identity, uptimeSec: 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

function recordDaemon(pid: number, port: number): void {
  writeWorkspaceDaemonRecord(WORKSPACE, {
    pid,
    port,
    startedAt: Date.now(),
    workspace: WORKSPACE,
  });
}

/** Give a wrongly-sent signal time to land, then assert the process is still there. */
async function expectStillAlive(pid: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(pidAlive(pid)).toBe(true);
}

/** Run a command in `--json` mode and return the parsed envelope it wrote to stdout. */
async function captureJson(run: () => Promise<void>): Promise<{ data: unknown }> {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return JSON.parse(writes.join('')) as { data: unknown };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-wsown-home-'));
  process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
  process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
  servers = [];
  children = [];
  ensureWorkspaceRegistry(WORKSPACE);
});

afterEach(() => {
  delete process.env.NOIR_WORKSPACES_DIR;
  delete process.env.NOIR_DAEMON_DIR;
  vi.restoreAllMocks();
  for (const server of servers) server.close();
  for (const child of children) child.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

describe('workspace stop proves ownership before signalling', () => {
  it('refuses a pid whose port answers as a different workspace, leaving it alive', async () => {
    const child = spawnLiveProcess();
    const port = await startHealthServer({ pid: child.pid ?? 0, workspace: 'other-workspace' });
    recordDaemon(child.pid ?? 0, port);

    await expect(workspaceStop({ name: WORKSPACE })).rejects.toMatchObject({
      exitCode: EXIT.ERROR,
      message: expect.stringContaining('other-workspace'),
    });

    // The unrelated process was not signalled…
    await expectStillAlive(child.pid ?? 0);
    // …and the record is left alone, so a human decides what to do with it.
    expect(readWorkspaceDaemonRecord(WORKSPACE)).not.toBeNull();
  });

  it('refuses a live pid that does not echo this pid back, leaving it alive', async () => {
    const child = spawnLiveProcess();
    const pid = child.pid ?? 0;
    const port = await startHealthServer({ pid: pid + 1, workspace: WORKSPACE });
    recordDaemon(pid, port);

    await expect(workspaceStop({ name: WORKSPACE })).rejects.toMatchObject({
      exitCode: EXIT.ERROR,
      message: expect.stringContaining(WORKSPACE),
    });

    await expectStillAlive(pid);
    expect(readWorkspaceDaemonRecord(WORKSPACE)).not.toBeNull();
  });

  it('signals and clears the record when the daemon answers as this workspace', async () => {
    const child = spawnLiveProcess();
    const pid = child.pid ?? 0;
    const port = await startHealthServer({ pid, workspace: WORKSPACE });
    recordDaemon(pid, port);

    const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
    const envelope = await captureJson(() => workspaceStop({ name: WORKSPACE, json: true }));

    expect(envelope.data).toMatchObject({ running: false, stopped: true, pid });
    await exited;
    expect(readWorkspaceDaemonRecord(WORKSPACE)).toBeNull();
  });
});

describe('workspace status and list report liveness from the probe', () => {
  it('status reports a stale record as not running, not a live daemon', async () => {
    const child = spawnLiveProcess();
    const pid = child.pid ?? 0;
    const port = await startHealthServer({ pid, workspace: 'other-workspace' });
    recordDaemon(pid, port);

    const envelope = await captureJson(() => workspaceStatus({ name: WORKSPACE, json: true }));

    expect(envelope.data).toMatchObject({ running: false, stale: true });
  });

  it('status reports running only when the daemon echoes the recorded pid and name', async () => {
    const child = spawnLiveProcess();
    const pid = child.pid ?? 0;
    const port = await startHealthServer({ pid, workspace: WORKSPACE });
    recordDaemon(pid, port);

    const envelope = await captureJson(() => workspaceStatus({ name: WORKSPACE, json: true }));

    expect(envelope.data).toMatchObject({ running: true, pid, port });
  });

  it('list does not claim a live daemon for a record that fails the probe', async () => {
    const child = spawnLiveProcess();
    const pid = child.pid ?? 0;
    const port = await startHealthServer({ pid, workspace: 'other-workspace' });
    recordDaemon(pid, port);

    const envelope = await captureJson(() => workspaceList({ json: true }));

    const row = (
      envelope.data as { workspaces: Array<{ name: string; running: boolean; stale?: boolean }> }
    ).workspaces.find((w) => w.name === WORKSPACE);
    expect(row).toMatchObject({ running: false, stale: true });
  });
});
