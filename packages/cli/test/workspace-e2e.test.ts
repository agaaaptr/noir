// The workspace transport, proven end to end across two repositories.
//
// This is the capstone proof for the cross-repo workspace workstream: two
// temporary git repositories join ONE workspace daemon, and the stdio bridge
// (`noir mcp serve --stdio --workspace <name>`) relays a real MCP session to
// that daemon for BOTH members, then refuses a third, non-member repository
// with the membership error. Everything is driven through the built CLI
// (`packages/cli/dist/bin.js`), so the CLI (and the daemon package it loads)
// must be built first — the full gate runs `pnpm build` before the suite, and
// this file fails with a clear message when the build is missing.
//
// The test is offline: the daemon and the bridge talk over the loopback address,
// and the read-only `host_status` tool needs no API key and no network. The
// teardown is part of the proof — after stopping the daemon the test asserts no
// process is left running and no daemon record is left on disk, so a leaked
// background daemon fails the file instead of stranding a process in CI.

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '@noir-ai/core';
import { pidAlive, readWorkspaceDaemonRecord } from '@noir-ai/daemon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WORKSPACE = 'e2e-ws';
const MEMBER_A = 'e2e-member-a';
const MEMBER_B = 'e2e-member-b';
const OUTSIDER = 'e2e-outsider';

/** The built CLI entry — this proof exercises the shipped artifact, not source. */
const BIN = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

// Isolate the workspace registry/record/store and the daemon token from any
// real `~/.noir` on this machine, so the spawned daemon and the in-process
// record reads below agree on the same isolated tree.
const home = mkdtempSync(join(tmpdir(), 'noir-e2e-home-'));
const repos = mkdtempSync(join(tmpdir(), 'noir-e2e-repos-'));
process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
const env = { ...process.env };

let daemon: ChildProcessWithoutNullStreams | undefined;
let daemonPid: number | undefined;
let repoA: string;
let repoB: string;
let outsider: string;

/** Poll `cond` until it is true or `timeoutMs` elapses (bounded, never hangs). */
function waitUntil(cond: () => boolean, what: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (cond()) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for ${what} (after ${timeoutMs}ms)`));
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

/** Resolve `true` once the child has finished, `false` if it outlives the bound. */
function awaitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** Run the built CLI to completion and return its exit code and captured streams. */
function runCli(
  args: string[],
  cwd: string,
  timeoutMs = 30000,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timed out running \`noir ${args.join(' ')}\``));
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/** A newline-delimited JSON-RPC request line for a bridge session. */
function rpc(id: number, method: string, params?: unknown): string {
  return `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
}

/** Create a temp git repository with the `.noir` identity a member needs. */
function initRepo(name: string, projectId: string): string {
  const root = join(repos, name);
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${projectId}\n`, 'utf8');
  // `embedder: none` keeps the member store open offline (no model, no key).
  writeFileSync(
    paths.config(root),
    'host: claude\nmode: full\ncontext:\n  embedder:\n    kind: none\n',
    'utf8',
  );
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

/** The args the host's `.mcp.json` `noir` entry was rewritten to on join. */
function noirEntryArgs(root: string): unknown {
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
    mcpServers: Record<string, { args?: unknown }>;
  };
  return mcp.mcpServers.noir?.args;
}

/** Drive a full bridge session for one member and assert every hop it crossed. */
async function runMemberSession(root: string, memberId: string): Promise<void> {
  const child = spawn(
    process.execPath,
    [BIN, 'mcp', 'serve', '--stdio', '--workspace', WORKSPACE],
    { cwd: root, env },
  );
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
  try {
    child.stdin.write(
      rpc(1, 'initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'e2e-host', version: '0' },
      }),
    );
    await waitUntil(() => out.includes('"id":1'), 'the initialize response', 30000);

    // `host_status` is read-only and offline, and its answer carries the CALLER's
    // project id — so it proves the shared daemon served the RIGHT member store.
    child.stdin.write(rpc(2, 'tools/call', { name: 'host_status', arguments: {} }));
    await waitUntil(() => out.includes('"id":2'), 'the host_status response', 30000);

    // Every line the host reads is a well-formed JSON-RPC message and nothing
    // else; the session's diagnostics never leak into the protocol stream.
    const lines = out.split('\n').filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const messages = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    const init = messages.find((m) => m.id === 1);
    expect(init).toBeDefined();
    expect((init?.result as { serverInfo?: { name?: string } })?.serverInfo?.name).toBe('noir');
    const call = messages.find((m) => m.id === 2);
    expect(JSON.stringify(call)).toContain(memberId);
    expect(err).toBe('');

    child.stdin.end();
    expect(await awaitExit(child, 15000)).toBe(true);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  } finally {
    child.kill('SIGKILL');
  }
}

beforeAll(async () => {
  if (!existsSync(BIN)) {
    throw new Error(`the built CLI is missing at ${BIN} — run \`pnpm build\` before this test`);
  }
  repoA = initRepo('repo-a', MEMBER_A);
  repoB = initRepo('repo-b', MEMBER_B);
  outsider = initRepo('outsider', OUTSIDER);

  // Found the workspace from repo A: `daemon start --workspace` registers repo A
  // as a member and keeps the daemon alive in THIS child process.
  daemon = spawn(process.execPath, [BIN, 'daemon', 'start', '--workspace', WORKSPACE, '--json'], {
    cwd: repoA,
    env,
  });
  const pid = daemon.pid;
  if (typeof pid !== 'number') {
    throw new Error('the workspace daemon child has no pid');
  }
  daemonPid = pid;
  let daemonOut = '';
  let daemonErr = '';
  daemon.stdout.setEncoding('utf8').on('data', (chunk: string) => (daemonOut += chunk));
  daemon.stderr.setEncoding('utf8').on('data', (chunk: string) => (daemonErr += chunk));
  try {
    await waitUntil(() => daemonOut.includes('\n'), 'the workspace daemon to start', 30000);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; daemon stderr: ${daemonErr.trim()}`,
    );
  }

  // Join repo B to the SAME daemon (reuse, not a second server), then confirm
  // both repos' host entries now name the workspace bridge.
  const joined = await runCli(['daemon', 'join', WORKSPACE, '--json'], repoB);
  expect(joined.code).toBe(0);
  expect(noirEntryArgs(repoA)).toEqual(['mcp', 'serve', '--stdio', '--workspace', WORKSPACE]);
  expect(noirEntryArgs(repoB)).toEqual(['mcp', 'serve', '--stdio', '--workspace', WORKSPACE]);
}, 60000);

afterAll(async () => {
  // Stop the daemon we started and wait for it to finish (bounded)...
  if (daemon !== undefined && daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM');
    if (!(await awaitExit(daemon, 15000))) {
      daemon.kill('SIGKILL');
      await awaitExit(daemon, 5000);
    }
  }
  // ...then assert the teardown is complete: no live process and no record
  // behind, so a leaked daemon fails the file instead of surviving the suite.
  if (daemonPid !== undefined) expect(pidAlive(daemonPid)).toBe(false);
  expect(readWorkspaceDaemonRecord(WORKSPACE)).toBeNull();
  delete process.env.NOIR_DAEMON_DIR;
  delete process.env.NOIR_WORKSPACES_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(repos, { recursive: true, force: true });
});

describe('workspace bridge end to end', () => {
  it.each([
    { label: 'repo-a', id: MEMBER_A, root: () => repoA },
    { label: 'repo-b', id: MEMBER_B, root: () => repoB },
  ])('serves a full session for the $label member', async ({ id, root }) => {
    await runMemberSession(root(), id);
  });

  it('refuses a non-member repository with the membership error', async () => {
    const child = spawn(
      process.execPath,
      [BIN, 'mcp', 'serve', '--stdio', '--workspace', WORKSPACE],
      { cwd: outsider, env },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (out += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    try {
      child.stdin.write(
        rpc(1, 'initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'e2e-host', version: '0' },
        }),
      );
      await waitUntil(
        () => err.includes('is not a member of workspace'),
        'the membership refusal',
        30000,
      );

      // The refusal names both the outsider and the workspace, and the host's
      // protocol stream got no successful initialize back.
      expect(err).toContain(OUTSIDER);
      expect(err).toContain(WORKSPACE);
      expect(out).toBe('');

      // The bridge ends the session on its own rather than hanging the host.
      expect(await awaitExit(child, 15000)).toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });
});
