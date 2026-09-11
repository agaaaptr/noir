// S9 t3 — daemon-client tests. The daemon + MCP client are mocked at the module
// boundary (no real daemon, no real HTTP — NF4: "daemonClient is injectable");
// these tests pin the S9 contract: parsed JSON on success, exit 4 (DAEMON_DOWN)
// on any transport / parse failure, JSON envelope + verbose detail on request,
// connection tear-down in finally, and logical-failure envelopes pass through as
// data.
import { type ProjectInfo, parseConfig } from '@noir-ai/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/client', () => ({
  Client: vi.fn(),
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@noir-ai/daemon', () => ({
  // daemon-client.ts imports `ensureDaemonRunning` (the ensure/start seam),
  // `readDaemonToken` (the HTTP bearer token, spec 6.1) and `tokenPath` (the
  // token file's path, named in the workspace 401 message); the record readers
  // live behind those, so no other export needs mocking here. The workspace path
  // (`probeWorkspaceDaemon`) additionally reads the workspace record + pid.
  ensureDaemonRunning: vi.fn(),
  readDaemonToken: vi.fn(),
  readWorkspaceDaemonRecord: vi.fn(),
  pidAlive: vi.fn(),
  tokenPath: vi.fn(),
}));

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  ensureDaemonRunning,
  pidAlive,
  readDaemonToken,
  readWorkspaceDaemonRecord,
  tokenPath,
} from '@noir-ai/daemon';
import { EXIT, NoirCliError } from '../src/bin.js';
import {
  callDaemonTool,
  DAEMON_DOWN_HINT,
  type DaemonClientOptions,
  withDaemon,
  withWorkspaceDaemon,
} from '../src/daemon-client.js';

const project: ProjectInfo = {
  id: 'test-project',
  name: 'daemon-client-test',
  root: '/tmp/noir-daemon-client-test',
  config: parseConfig({ host: 'claude' }),
};

const baseOpts: DaemonClientOptions = { project };

/** A daemon URL shape compatible with `new URL(...)` (127.0.0.1 only). */
const DAEMON_URL = 'http://127.0.0.1:65432/mcp';

/** Permissive MCP content block shape (index sig absorbs image/audio/etc extras). */
interface FakeContent {
  type: string;
  text?: string;
  [extra: string]: unknown;
}

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Install a fake MCP `Client` instance + transport onto the mocked modules. */
function installFakeClient(
  behaviour: {
    connect?: () => Promise<void>;
    callTool?: (req: {
      name: string;
      arguments?: Record<string, unknown>;
    }) => Promise<{ content: ReadonlyArray<FakeContent> }>;
    close?: () => Promise<void>;
  } = {},
): FakeClient {
  const fake: FakeClient = {
    connect: vi.fn(behaviour.connect ?? (async () => {})),
    callTool: vi.fn(
      behaviour.callTool ??
        (async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] })),
    ),
    close: vi.fn(behaviour.close ?? (async () => {})),
  };
  vi.mocked(Client).mockImplementation(() => fake as unknown as Client);
  vi.mocked(StreamableHTTPClientTransport).mockImplementation(
    () => ({}) as unknown as StreamableHTTPClientTransport,
  );
  // Default: no daemon token on disk for this project (a stdio-only or
  // pre-auth daemon). Tests that need a bearer override this AFTER this call
  // (`vi.resetAllMocks()` in beforeEach wipes any earlier implementation).
  vi.mocked(readDaemonToken).mockReturnValue(null);
  return fake;
}

/** The options object the mocked transport was constructed with, if any. */
function transportOptions(call = 0): { requestInit?: { headers?: Record<string, string> } } {
  return (vi.mocked(StreamableHTTPClientTransport).mock.calls[call]?.[1] ?? {}) as {
    requestInit?: { headers?: Record<string, string> };
  };
}

/** Install a fake `ensureDaemonRunning` result. */
function installEnsure(over: Partial<{ started: boolean; stop: () => Promise<void> }> = {}): {
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(async () => {});
  vi.mocked(ensureDaemonRunning).mockResolvedValue({
    port: 65432,
    url: DAEMON_URL,
    started: over.started ?? false,
    stop: over.stop ?? stop,
  });
  return { stop };
}

/** Capture everything written to stderr while `fn` runs. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

/** Capture everything written to stdout while `fn` runs. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    chunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join('');
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('callDaemonTool — success', () => {
  it('parses the text-JSON tool result and returns the payload', async () => {
    installEnsure();
    const fake = installFakeClient({
      callTool: async () => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, host: 'claude', pid: 123 }) }],
      }),
    });

    const payload = await callDaemonTool(baseOpts, 'host_status', {});

    expect(payload).toEqual({ ok: true, host: 'claude', pid: 123 });
    // The tool is called with the exact name + args; transport is constructed
    // against the daemon URL from ensureDaemonRunning.
    expect(ensureDaemonRunning).toHaveBeenCalledWith({
      project,
      idleTimeoutSec: project.config.daemon.idleTimeoutSec,
    });
    expect(fake.callTool).toHaveBeenCalledWith({ name: 'host_status', arguments: {} });
    expect(fake.connect).toHaveBeenCalledTimes(1);
  }, 10000);

  it('passes arguments through untouched', async () => {
    installEnsure();
    const fake = installFakeClient();
    await callDaemonTool(baseOpts, 'context_search', { query: 'auth flow', limit: 5 });
    expect(fake.callTool).toHaveBeenCalledWith({
      name: 'context_search',
      arguments: { query: 'auth flow', limit: 5 },
    });
  });

  it('defaults arguments to {} when omitted', async () => {
    installEnsure();
    const fake = installFakeClient();
    await callDaemonTool(baseOpts, 'store_status');
    expect(fake.callTool).toHaveBeenCalledWith({ name: 'store_status', arguments: {} });
  });

  it('returns a logical-failure envelope as data (NOT exit 4)', async () => {
    // A tool's own `{ok:false, degraded:true}` is structured data, not a
    // transport failure — daemon-client must surface it for the command module
    // to interpret, never remap it onto DAEMON_DOWN.
    installEnsure();
    installFakeClient({
      callTool: async () => ({
        content: [
          { type: 'text', text: JSON.stringify({ ok: false, degraded: true, error: 'read-only' }) },
        ],
      }),
    });

    const payload = await callDaemonTool(baseOpts, 'memory_save', { content: 'x' });

    expect(payload).toEqual({ ok: false, degraded: true, error: 'read-only' });
  });
});

describe('connectClient — bearer token (spec 6.1)', () => {
  it('sends the daemon bearer token for this project on the /mcp connect', async () => {
    installEnsure();
    installFakeClient();
    vi.mocked(readDaemonToken).mockReturnValue('tok-123');

    await callDaemonTool(baseOpts, 'host_status');

    // The token is read for THIS project's scope key and delivered verbatim as
    // a bearer header — the daemon 401s the request otherwise.
    expect(vi.mocked(readDaemonToken)).toHaveBeenCalledWith(project.id);
    expect(transportOptions().requestInit?.headers?.Authorization).toBe('Bearer tok-123');
  });

  it('sends no Authorization header when no token is on disk', async () => {
    installEnsure();
    installFakeClient();

    await callDaemonTool(baseOpts, 'host_status');

    expect(readDaemonToken).toHaveBeenCalledWith(project.id);
    expect(transportOptions().requestInit).toBeUndefined();
  });

  it('the workspace path sends the WORKSPACE token (scope key = workspace name), never the project token', async () => {
    // A workspace daemon's identity is its NAME (spec §6.3): the connect must
    // present THAT secret, not the caller's project token — the two are
    // different daemons and different credentials.
    const routing = { name: 'ws-demo', projectId: project.id };
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue({
      pid: process.pid,
      port: 65432,
      startedAt: Date.now(),
      workspace: 'ws-demo',
    });
    vi.mocked(pidAlive).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, pid: process.pid, workspace: 'ws-demo' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    installFakeClient();
    vi.mocked(readDaemonToken).mockReturnValue('ws-tok-456');

    await withWorkspaceDaemon(baseOpts, routing, (caller) => caller.callTool('memory_recall'));

    expect(readDaemonToken).toHaveBeenCalledWith('ws-demo');
    expect(readDaemonToken).not.toHaveBeenCalledWith(project.id);
    expect(transportOptions().requestInit?.headers?.Authorization).toBe('Bearer ws-tok-456');
  });
});

describe('withWorkspaceDaemon — connect 401 (token mismatch)', () => {
  it('names the token file instead of the generic "daemon not reachable" hint', async () => {
    // A 401 means the workspace daemon IS running and reachable — it rejected
    // our bearer token (a stale or unreadable token file). The message must
    // name the token file + remedy, NOT the generic start hint (which would be
    // wrong: the daemon is already started).
    const routing = { name: 'ws-demo', projectId: project.id };
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue({
      pid: process.pid,
      port: 65432,
      startedAt: Date.now(),
      workspace: 'ws-demo',
    });
    vi.mocked(pidAlive).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, pid: process.pid, workspace: 'ws-demo' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    installFakeClient({
      connect: async () => Promise.reject(new Error('HTTP 401 Unauthorized')),
    });
    vi.mocked(tokenPath).mockReturnValue('/tmp/noir-daemons/ws-demo.token');

    const err = (await withWorkspaceDaemon(baseOpts, routing, (caller) =>
      caller.callTool('memory_recall'),
    ).catch((e) => e as NoirCliError)) as NoirCliError;

    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN); // exit code unchanged
    expect(err.message).toMatch(/401/);
    expect(err.message).toContain('/tmp/noir-daemons/ws-demo.token'); // the token file
    expect(err.message).toContain('ws-demo'); // the workspace scope key
    expect(err.message).not.toMatch(/daemon not reachable/); // NOT the generic hint
  });

  it('keeps the generic hint for a non-401 connect failure (conservative)', async () => {
    const routing = { name: 'ws-demo', projectId: project.id };
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue({
      pid: process.pid,
      port: 65432,
      startedAt: Date.now(),
      workspace: 'ws-demo',
    });
    vi.mocked(pidAlive).mockReturnValue(true);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true, pid: process.pid, workspace: 'ws-demo' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    installFakeClient({ connect: async () => Promise.reject(new Error('ECONNREFUSED')) });

    const err = (await withWorkspaceDaemon(baseOpts, routing, (caller) =>
      caller.callTool('memory_recall'),
    ).catch((e) => e as NoirCliError)) as NoirCliError;

    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
    expect(err.message).toBe(DAEMON_DOWN_HINT);
    expect(err.message).not.toContain('token');
  });
});

describe('callDaemonTool — teardown', () => {
  it('closes the client in finally on success', async () => {
    installEnsure();
    const fake = installFakeClient();
    await callDaemonTool(baseOpts, 'host_status');
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('calls stop() in finally even for a reused (started:false) daemon', async () => {
    // ensureDaemonRunning's started:false stop is a no-op in production, but
    // daemon-client calls it unconditionally — this proves the finally runs and
    // hands the recorded stop through (so started:true would tear down).
    const { stop } = installEnsure({ started: false });
    installFakeClient();
    await callDaemonTool(baseOpts, 'host_status');
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('calls stop() in finally when the tool call throws', async () => {
    const { stop } = installEnsure({ started: true });
    const fake = installFakeClient({ callTool: async () => Promise.reject(new Error('boom')) });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
    // Both the connection AND the started daemon are torn down despite the throw.
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('callDaemonTool — daemon-down failures map to exit 4', () => {
  it('ensureDaemonRunning rejection → NoirCliError exit 4', async () => {
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('no free port'));
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
    // No client was constructed (ensure failed before connect).
    expect(vi.mocked(Client)).not.toHaveBeenCalled();
  });

  it('connect rejection → exit 4 + client closed', async () => {
    installEnsure();
    const fake = installFakeClient({
      connect: async () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('callTool rejection → exit 4', async () => {
    installEnsure();
    installFakeClient({ callTool: async () => Promise.reject(new Error('protocol error')) });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
  });

  it('non-text content → exit 4', async () => {
    installEnsure();
    installFakeClient({
      callTool: async () => ({ content: [{ type: 'image', data: 'x' }] }),
    });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
  });

  it('empty content array → exit 4', async () => {
    installEnsure();
    installFakeClient({ callTool: async () => ({ content: [] }) });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
  });

  it('non-JSON text → exit 4', async () => {
    installEnsure();
    installFakeClient({
      callTool: async () => ({ content: [{ type: 'text', text: 'not-json' }] }),
    });
    await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
      exitCode: EXIT.DAEMON_DOWN,
    });
  });

  it('the exit-4 message names the remediation command', async () => {
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('down'));
    // callDaemonTool defaults to `Promise<unknown>`, so the `await ...catch` is
    // `unknown | NoirCliError` → `unknown`. Cast at the assignment site so TS
    // lets us read .exitCode/.message; the test's intent is explicit (the
    // rejection is the NoirCliError failDaemonDown throws).
    const err = (await callDaemonTool(baseOpts, 'host_status').catch(
      (e) => e as NoirCliError,
    )) as NoirCliError;
    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
    expect(err.message).toMatch(/daemon not reachable/);
    expect(err.message).toMatch(/noir daemon start/);
  });
});

describe('callDaemonTool — diagnostics', () => {
  it('--verbose surfaces the underlying cause on stderr', async () => {
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('port in use'));
    const stderr = await captureStderr(async () => {
      await expect(
        callDaemonTool({ ...baseOpts, verbose: true }, 'host_status'),
      ).rejects.toMatchObject({ exitCode: EXIT.DAEMON_DOWN });
    });
    expect(stderr).toMatch(/daemon transport detail/);
    expect(stderr).toMatch(/port in use/);
  });

  it('--json emits the SINGLE {ok:false,error:{code,message}} envelope on stdout (no double-encoding)', async () => {
    // Regression guard: failDaemonDown must pass the PLAIN hint to fail() and
    // let output.ts shape ONE envelope on stdout. The prior bug pre-stringified
    // an inner {ok,error} and passed it as `message`, so fail() wrapped it again
    // and `error.message` was itself a JSON string.
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('down'));
    const out = await captureStdout(async () => {
      await expect(
        callDaemonTool({ ...baseOpts, json: true }, 'host_status'),
      ).rejects.toMatchObject({ exitCode: EXIT.DAEMON_DOWN });
    });
    // Exactly one envelope, shaped once by output.ts:fail.
    const env = JSON.parse(out) as {
      ok: boolean;
      error: { code: number; message: string };
    };
    expect(env.ok).toBe(false);
    expect(env.error.code).toBe(EXIT.DAEMON_DOWN); // numeric 4, not 'daemon-down'
    expect(env.error.message).toBe(DAEMON_DOWN_HINT); // the plain hint string
    expect(env.error.message).toMatch(/noir daemon start/);
    // Regression guard: the message must NOT itself be valid JSON — that would
    // mean it was pre-stringified into an inner envelope (the prior bug).
    expect(() => JSON.parse(env.error.message)).toThrow(SyntaxError);
  });

  it('omits verbose stderr by default (no transport detail line)', async () => {
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('down'));
    const stderr = await captureStderr(async () => {
      await expect(callDaemonTool(baseOpts, 'host_status')).rejects.toMatchObject({
        exitCode: EXIT.DAEMON_DOWN,
      });
    });
    expect(stderr).not.toMatch(/daemon transport detail/);
  });
});

describe('withDaemon — multi-call over one connection', () => {
  it('runs several callTool invocations on a single client + closes once', async () => {
    installEnsure();
    const fake = installFakeClient({
      callTool: vi.fn(async (req: { name: string }) => ({
        content: [{ type: 'text', text: JSON.stringify({ ok: true, name: req.name }) }],
      })),
    });

    const result = await withDaemon(baseOpts, async (caller) => {
      const a = await caller.callTool('host_status');
      const b = await caller.callTool('store_status');
      return { a, b };
    });

    expect(result).toEqual({
      a: { ok: true, name: 'host_status' },
      b: { ok: true, name: 'store_status' },
    });
    expect(fake.callTool).toHaveBeenCalledTimes(2);
    // One connection shared across both calls — connect + close each happen once.
    expect(fake.connect).toHaveBeenCalledTimes(1);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('propagates a fn-thrown NoirCliError untouched (command owns the exit code)', async () => {
    installEnsure();
    installFakeClient();
    const commandError = new NoirCliError(EXIT.ERROR, 'business rule failed');
    await expect(
      withDaemon(baseOpts, async () => {
        throw commandError;
      }),
    ).rejects.toBe(commandError);
  });
});
