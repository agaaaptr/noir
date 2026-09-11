// Task 6 (spec 6.1) — `noir daemon token`: the one-line data channel a host's
// MCP `headersHelper` runs at connect time, so no secret lives in a config file.
//
// The command resolves the caller's project from process.cwd(), reads that
// project's daemon record + token, and prints the token to STDOUT and nothing
// else. Every "no usable token" outcome is exit 4 (DAEMON_DOWN): uninitialized
// project, no record, a record whose daemon is gone, a record with no token
// beside it.
//
// The per-project record AND token live under NOIR_DAEMON_DIR (the same override
// the daemon module reads), so this file never touches the developer's real
// ~/.noir/daemons: every token asserted here is a SEEDED test value.

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '@noir-ai/core';
import { writeDaemonToken, writeProjectDaemonRecord } from '@noir-ai/daemon';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { daemonToken } from '../src/commands/daemon.js';
import { EXIT, inferExitCode } from '../src/output.js';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-daemon-token-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const PROJECT_ID = 'daemon-token-project';
const OTHER_PROJECT_ID = 'daemon-token-other';
/** Seeded test credential — never a real token (the real one is 43 base64url). */
const TOKEN = 'seeded-test-token-not-a-credential';

let root: string;
let origCwd: string;
let healthServer: Server | null = null;

/**
 * A live `/health` on the fixed record port answering for THIS project with THIS
 * pid — the shape a real daemon leaves. `noir daemon token` must now PROVE the
 * daemon is healthy, so the success paths need a genuine /health endpoint.
 */
function startHealthServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    healthServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pid: process.pid, projectId: PROJECT_ID }));
      } else {
        res.writeHead(404).end();
      }
    });
    healthServer.once('error', reject);
    healthServer.listen(51234, '127.0.0.1', () => resolve());
  });
}

function stopHealthServer(): Promise<void> {
  if (!healthServer) return Promise.resolve();
  const s = healthServer;
  healthServer = null;
  return new Promise((resolve) => s.close(() => resolve()));
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-daemon-token-root-'));
  origCwd = process.cwd();
  mkdirSync(paths.noirDir(root), { recursive: true });
  writeFileSync(paths.projectId(root), `${PROJECT_ID}\n`, 'utf8');
  writeFileSync(paths.config(root), 'host: claude\nmode: full\n', 'utf8');
  process.chdir(root);
  await startHealthServer();
});

afterEach(async () => {
  await stopHealthServer();
  process.chdir(origCwd);
  rmSync(root, { recursive: true, force: true });
  for (const f of readdirSync(tmpRoot)) rmSync(join(tmpRoot, f), { force: true });
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** A pid guaranteed to be dead (a child that has already exited). */
function deadPid(): number {
  const res = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  return typeof res.pid === 'number' ? res.pid : 999_999;
}

/**
 * The exact pair the daemon itself leaves on disk for a live daemon: a record
 * (which is what tells a client a token is worth reading) + the 0600 token file
 * beside it. The pid is THIS process — the liveness check must see it alive.
 */
function seedLiveDaemon(id: string, token = TOKEN): void {
  writeProjectDaemonRecord(id, {
    pid: process.pid,
    port: 51234,
    startedAt: Date.now(),
    projectId: id,
  });
  writeDaemonToken(id, token);
}

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

describe('noir daemon token', () => {
  it('prints the token to stdout and nothing else (exit 0)', async () => {
    seedLiveDaemon(PROJECT_ID);
    const r = await run(() => daemonToken({}));
    expect(r.err).toBeUndefined();
    // Byte-exact: the token, one newline, no envelope, no banner, no second line.
    expect(r.stdout).toBe(`${TOKEN}\n`);
    expect(r.stderr).toBe('');
  });

  it('--json emits the {ok:true,data:{token}} envelope (the only stdout write)', async () => {
    seedLiveDaemon(PROJECT_ID);
    const r = await run(() => daemonToken({ json: true }));
    expect(r.err).toBeUndefined();
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, data: { token: TOKEN } });
    expect(r.stderr).toBe('');
  });

  it('reads the token at CALL time: a rotated token is what is printed', async () => {
    seedLiveDaemon(PROJECT_ID, 'first-token');
    expect((await run(() => daemonToken({}))).stdout).toBe('first-token\n');
    // The daemon regenerates its token on every start — a cached copy would 401.
    writeDaemonToken(PROJECT_ID, 'rotated-token');
    expect((await run(() => daemonToken({}))).stdout).toBe('rotated-token\n');
  });

  it('no daemon record → exit 4, empty stdout, hint on stderr', async () => {
    const r = await run(() => daemonToken({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/not running/);
    expect(r.stderr).toMatch(/noir daemon start/);
  });

  it('no daemon record under --json → structured daemon-down envelope (exit 4)', async () => {
    const r = await run(() => daemonToken({ json: true }));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    const envelope = JSON.parse(r.stdout);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe(EXIT.DAEMON_DOWN);
    expect(envelope.error.message).toMatch(/not running/);
  });

  it('a record with a dead pid → exit 4 without printing a token', async () => {
    writeProjectDaemonRecord(PROJECT_ID, {
      pid: deadPid(),
      port: 51234,
      startedAt: Date.now(),
      projectId: PROJECT_ID,
    });
    writeDaemonToken(PROJECT_ID, TOKEN);
    const r = await run(() => daemonToken({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/stale/);
  });

  it('a RECYCLED pid (alive, but /health answers for a foreign process) → exit 4, no token', async () => {
    // The hazard the liveness-only check missed: the recorded pid is alive
    // because an unrelated process recycled it. `/health` here answers with a
    // DIFFERENT pid, so the record must be refused — printing its token would
    // authenticate nothing while looking like success.
    const foreign: Server = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, pid: process.pid + 1, projectId: PROJECT_ID }));
      } else {
        res.writeHead(404).end();
      }
    });
    const port: number = await new Promise((resolve) => {
      foreign.listen(0, '127.0.0.1', () => {
        const addr = foreign.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
    try {
      writeProjectDaemonRecord(PROJECT_ID, {
        pid: process.pid, // alive — the liveness-only check would have passed
        port,
        startedAt: Date.now(),
        projectId: PROJECT_ID,
      });
      writeDaemonToken(PROJECT_ID, TOKEN);
      const r = await run(() => daemonToken({}));
      expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
      expect(r.stdout).toBe('');
      expect(r.stdout).not.toContain(TOKEN);
    } finally {
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  });

  it('a live pid whose /health is unreachable (nothing listening) → exit 4, no token', async () => {
    // pidAlive() is true but no daemon answers: the token is for a daemon that
    // is not there. Port 1 is closed/privileged — nothing to connect to.
    writeProjectDaemonRecord(PROJECT_ID, {
      pid: process.pid,
      port: 1,
      startedAt: Date.now(),
      projectId: PROJECT_ID,
    });
    writeDaemonToken(PROJECT_ID, TOKEN);
    const r = await run(() => daemonToken({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stdout).toBe('');
  });

  it('a record with no token beside it → exit 4 (nothing to authenticate with)', async () => {
    writeProjectDaemonRecord(PROJECT_ID, {
      pid: process.pid,
      port: 51234,
      startedAt: Date.now(),
      projectId: PROJECT_ID,
    });
    const r = await run(() => daemonToken({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/no token/);
  });

  it("never prints another project's token (the record IS the scope)", async () => {
    // A live daemon for a DIFFERENT project: this project has no record of its
    // own, so there is no token to print — and the other project's secret must
    // not leak into stdout or stderr.
    seedLiveDaemon(OTHER_PROJECT_ID, 'other-project-secret');
    const r = await run(() => daemonToken({}));
    expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toMatch(/other-project-secret/);
  });

  it('an uninitialized directory → exit 4 (no project to scope a token to)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'noir-daemon-token-empty-'));
    try {
      process.chdir(empty);
      const r = await run(() => daemonToken({}));
      expect(inferExitCode(r.err)).toBe(EXIT.DAEMON_DOWN);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/not running/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('the printed value is the token file contents, newline-trimmed', async () => {
    // The daemon writes `<token>\n`; the command must emit exactly one newline,
    // never the file's trailing one doubled (`token\n\n` would break a
    // headersHelper that takes the whole line).
    seedLiveDaemon(PROJECT_ID, 'token-with-no-whitespace');
    const r = await run(() => daemonToken({}));
    expect(r.stdout.endsWith('\n')).toBe(true);
    expect(r.stdout.endsWith('\n\n')).toBe(false);
    expect(r.stdout.trim()).toBe('token-with-no-whitespace');
  });
});
