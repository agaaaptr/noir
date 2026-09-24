// The workspace stdio bridge: turning a workspace name into a reachable address
// plus its secret, and relaying a host's MCP traffic to that daemon.
//
// Every test here runs offline. Resolution tests stub `fetch`, so a daemon that
// is silent or foreign is simulated without opening a socket. The relay is
// driven through the real CLI (`noir mcp serve --stdio --workspace …`) against a
// local HTTP server that answers the same two endpoints the workspace daemon
// does (`/health` and `/mcp`), so the flag, the routing and the relay are all
// covered by the same session.

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';
import { paths } from '@noir-ai/core';
import { tokenPath, writeDaemonToken, writeWorkspaceDaemonRecord } from '@noir-ai/daemon';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXIT } from '../src/output.js';
import { bridgeStdioToWorkspace, resolveWorkspaceDaemon } from '../src/workspace-bridge.js';

const WORKSPACE = 'demo';
const TOKEN = 'workspace-token-used-by-the-bridge-test';
/** A project id only has to be path-safe, so the fixture uses a readable slug. */
const CALLER_PROJECT_ID = 'fe-repo';
const PROBE_PORT = 4444;

// `node --import tsx` resolves the `tsx` bare specifier relative to the child's
// cwd, and the fixture repo has no node_modules — resolve it to an absolute file
// URL up front instead.
const require = createRequire(import.meta.url);
const TSX_LOADER = pathToFileURL(require.resolve('tsx')).href;
const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url));

const INITIALIZE_REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'host', version: '0' },
  },
};

let home: string;
let root: string;
let servers: Server[];

/** Record a daemon for the fixture workspace, as `daemon start --workspace` would. */
function recordDaemon(record: { pid: number; port: number }): void {
  writeWorkspaceDaemonRecord(WORKSPACE, {
    pid: record.pid,
    port: record.port,
    startedAt: Date.now(),
    workspace: WORKSPACE,
  });
}

/**
 * Replace `fetch` with a stub that answers every request with `body`. A `null`
 * body simulates a daemon that accepts no connection at all. The mock is
 * returned so a test can assert how often — and where — the bridge probed.
 */
function stubHealth(body: unknown | null) {
  const mock = vi.fn(async (_url: unknown, _init?: { signal?: AbortSignal | null }) => {
    if (body === null) throw new TypeError('fetch failed');
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

/**
 * A stand-in for the workspace daemon: it answers `/health` with the given
 * identity and replies to every `/mcp` POST with a well-formed result, recording
 * the URL and authorization header each request carried.
 */
async function startFakeDaemon(opts: { pid: number; workspace: string }): Promise<{
  port: number;
  targets: string[];
  authorizations: (string | undefined)[];
  close: () => Promise<void>;
}> {
  const targets: string[] = [];
  const authorizations: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, pid: opts.pid, workspace: opts.workspace, uptimeSec: 1 }));
      return;
    }
    if (req.url?.startsWith('/mcp')) {
      targets.push(req.url);
      authorizations.push(req.headers.authorization);
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8');
      });
      req.on('end', () => {
        const message = JSON.parse(body) as { id?: number };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'fake-workspace', version: '0.0.0' },
            },
          }),
        );
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    port: (server.address() as AddressInfo).port,
    targets,
    authorizations,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Collect everything written to stderr while `body` runs. */
async function captureStderr(body: () => Promise<void>): Promise<string[]> {
  const written: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  try {
    await body();
  } finally {
    spy.mockRestore();
  }
  return written;
}

/** A writable that keeps everything written to it, so a test can inspect it. */
function captureStream(): { stream: Writable; written: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, written: () => chunks.join('') };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'noir-bridge-home-'));
  process.env.NOIR_WORKSPACES_DIR = join(home, 'workspaces');
  process.env.NOIR_DAEMON_DIR = join(home, 'daemons');
  root = mkdtempSync(join(tmpdir(), 'noir-bridge-repo-'));
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${CALLER_PROJECT_ID}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  servers = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const server of servers) server.close();
  delete process.env.NOIR_WORKSPACES_DIR;
  delete process.env.NOIR_DAEMON_DIR;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('resolveWorkspaceDaemon', () => {
  it('reports that no daemon is recorded for the workspace', async () => {
    await expect(resolveWorkspaceDaemon(WORKSPACE, root)).resolves.toEqual({
      error: `no daemon recorded for workspace ${WORKSPACE}`,
    });
  });

  it('reports the recorded pid, probing once, when the daemon does not answer', async () => {
    recordDaemon({ pid: process.pid, port: PROBE_PORT });
    const fetchMock = stubHealth(null);

    await expect(resolveWorkspaceDaemon(WORKSPACE, root)).resolves.toEqual({
      error: `record exists but the daemon is not answering (pid ${process.pid})`,
    });

    // One bounded probe: a daemon that does not answer is never retried, or a
    // host waiting on its MCP server would wait for as long as the retries last.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`http://127.0.0.1:${PROBE_PORT}/health`);
    // …and the probe cannot outlive its own bound.
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeDefined();
  });

  it('refuses a daemon answering as a different workspace, naming both', async () => {
    recordDaemon({ pid: process.pid, port: PROBE_PORT });
    stubHealth({ ok: true, pid: process.pid, workspace: 'other-workspace' });

    const resolved = await resolveWorkspaceDaemon(WORKSPACE, root);

    expect('error' in resolved && resolved.error).toContain(WORKSPACE);
    expect('error' in resolved && resolved.error).toContain('other-workspace');
  });

  it('refuses a record whose pid no longer matches the daemon answering', async () => {
    // A recycled pid passes the liveness check while the process behind it is
    // something else entirely, so the record is not trusted until the answer
    // carries the same pid back.
    recordDaemon({ pid: process.pid, port: PROBE_PORT });
    stubHealth({ ok: true, pid: process.pid + 1, workspace: WORKSPACE });

    await expect(resolveWorkspaceDaemon(WORKSPACE, root)).resolves.toEqual({
      error: `record exists but the daemon is not answering (pid ${process.pid})`,
    });
  });

  it('resolves the address and the secret of a healthy daemon', async () => {
    recordDaemon({ pid: process.pid, port: PROBE_PORT });
    writeDaemonToken(WORKSPACE, TOKEN);
    stubHealth({ ok: true, pid: process.pid, workspace: WORKSPACE });

    await expect(resolveWorkspaceDaemon(WORKSPACE, root)).resolves.toEqual({
      url: `http://127.0.0.1:${PROBE_PORT}/mcp?p=${CALLER_PROJECT_ID}`,
      token: TOKEN,
    });
    // The secret comes from the owner-only file the daemon minted it into.
    expect(statSync(tokenPath(WORKSPACE)).mode & 0o777).toBe(0o600);
  });

  it('names the token file, never a value, when the daemon has no readable secret', async () => {
    recordDaemon({ pid: process.pid, port: PROBE_PORT });
    stubHealth({ ok: true, pid: process.pid, workspace: WORKSPACE });

    const resolved = await resolveWorkspaceDaemon(WORKSPACE, root);

    expect('error' in resolved && resolved.error).toContain(tokenPath(WORKSPACE));
  });
});

describe('bridgeStdioToWorkspace', () => {
  it('fails with the daemon-down exit code, on stderr only, when no daemon is recorded', async () => {
    const out = captureStream();

    const written = await captureStderr(async () => {
      await expect(bridgeStdioToWorkspace(WORKSPACE, root)).rejects.toMatchObject({
        exitCode: EXIT.DAEMON_DOWN,
      });
    });

    expect(written.join('')).toContain(`no daemon recorded for workspace ${WORKSPACE}`);
    // stdout belongs to the host's protocol traffic — a failure must not be
    // written where the host would read it as a message.
    expect(out.written()).toBe('');
  });

  it('relays a session to the workspace daemon without ever writing the secret out', async () => {
    const daemon = await startFakeDaemon({ pid: process.pid, workspace: WORKSPACE });
    recordDaemon({ pid: process.pid, port: daemon.port });
    writeDaemonToken(WORKSPACE, TOKEN);

    const child = spawn(
      process.execPath,
      ['--import', TSX_LOADER, BIN, 'mcp', 'serve', '--stdio', '--workspace', WORKSPACE],
      { cwd: root },
    );
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    const exited = new Promise<number | null>((resolve) => child.on('close', resolve));

    try {
      child.stdin.write(`${JSON.stringify(INITIALIZE_REQUEST)}\n`);
      await vi.waitFor(() => expect(out).toContain('"id":1'), { timeout: 30000 });

      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
      await vi.waitFor(() => expect(out).toContain('"id":2'), { timeout: 30000 });

      // Every line the host reads is a JSON-RPC message, and nothing else: the
      // secret is never in the stream, and neither is any diagnostic.
      const lines = out.split('\n').filter((line) => line.trim().length > 0);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      for (const line of lines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(out).not.toContain(TOKEN);
      expect(err).not.toContain(TOKEN);

      // The daemon's own answers reached the host unaltered, the caller's member
      // id travelled in the query string it authorises against, and the secret
      // travelled as a bearer header.
      expect(out).toContain('fake-workspace');
      expect(daemon.targets).toEqual([
        `/mcp?p=${CALLER_PROJECT_ID}`,
        `/mcp?p=${CALLER_PROJECT_ID}`,
      ]);
      expect(daemon.authorizations).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);

      // Closing the host's side closes the daemon's and lets the bridge end.
      child.stdin.end();
      await expect(exited).resolves.toBe(0);
    } finally {
      child.kill('SIGKILL');
      await daemon.close();
    }
  }, 40000);
});
