// Task 7 — connect-first daemon activation on the PROJECT path (spec §7).
//
// `withDaemon` used to be ensure-first: `ensureDaemonRunning` (which spawns a
// daemon when none is healthy) ran BEFORE any connection was attempted, so a
// daemon started as a side effect of running a command. With a configured
// `daemon.port` there is now a STABLE address to try first, so the order is
// reversed: connect directly, and spawn only when that connection is refused.
// Without a configured port there is nothing to probe and today's ensure-first
// ordering is retained verbatim (spec 7.1 — D depends on B).
//
// The project daemon + MCP client are mocked at the module boundary (no real
// daemon, no real HTTP), following the per-file mock pattern established in
// `daemon-client.test.ts`. The last describe block is the regression guard that
// matters most: `withWorkspaceDaemon` must stay PROBE-ONLY (ADR-0009 §11) and
// must never be routed through the new activation path.
import { type ProjectInfo, parseConfig } from '@noir-ai/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/client', () => ({
  Client: vi.fn(),
  StreamableHTTPClientTransport: vi.fn(),
}));

vi.mock('@noir-ai/daemon', () => ({
  // daemon-client.ts imports `ensureDaemonRunning` (the spawn seam),
  // `readDaemonToken` (the HTTP bearer token, spec 6.1), `tokenPath` (named in
  // the workspace 401 message) and — for the workspace probe — the workspace
  // record reader + pid check.
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
} from '@noir-ai/daemon';
import { EXIT } from '../src/bin.js';
import {
  callDaemonTool,
  DAEMON_DOWN_HINT,
  type DaemonClientOptions,
  PROBE_TIMEOUT_MS,
  withWorkspaceDaemon,
} from '../src/daemon-client.js';

/** The port the test project pins in `daemon.port` (a stable address). */
const CONFIGURED_PORT = 65432;

/** A daemon URL shape compatible with `new URL(...)` (127.0.0.1 only). */
const DAEMON_URL = 'http://127.0.0.1:65432/mcp';

const project: ProjectInfo = {
  id: 'connect-first-test',
  name: 'connect-first-test',
  root: '/tmp/noir-connect-first-test',
  config: parseConfig({ host: 'claude' }),
};

/** The same project WITH a stable daemon address configured. */
const portedProject: ProjectInfo = {
  ...project,
  config: parseConfig({ host: 'claude', daemon: { port: CONFIGURED_PORT } }),
};

const baseOpts: DaemonClientOptions = { project };
const portedOpts: DaemonClientOptions = { project: portedProject };

interface FakeClient {
  connect: ReturnType<typeof vi.fn>;
  callTool: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

/** Per-construction behaviour for {@link installFakeClients}. */
interface FakeBehaviour {
  connect?: () => Promise<void>;
  callTool?: (req: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<{ content: ReadonlyArray<{ type: string; text?: string }> }>;
}

/**
 * Install a fake MCP `Client` class over the mocked module. Each `new Client()`
 * gets a DISTINCT instance driven by `behaviours[i]` (construction order) — the
 * connect-first path builds a throwaway probe client and then a separate retry
 * client, and the assertions have to tell their `connect` / `close` calls apart
 * (a single shared fake would make "was the probe closed?" unanswerable).
 *
 * The returned array is filled LAZILY (as each `new Client()` runs), so read it
 * at assertion time via {@link clientAt} — never destructure it up front, which
 * would capture `undefined` before the first client exists.
 */
function installFakeClients(behaviours: FakeBehaviour[] = []): FakeClient[] {
  const made: FakeClient[] = [];
  vi.mocked(Client).mockImplementation(() => {
    const b = behaviours[made.length] ?? {};
    const fake: FakeClient = {
      connect: vi.fn(b.connect ?? (async () => {})),
      callTool: vi.fn(
        b.callTool ??
          (async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] })),
      ),
      close: vi.fn(async () => {}),
    };
    made.push(fake);
    return fake as unknown as Client;
  });
  vi.mocked(StreamableHTTPClientTransport).mockImplementation(
    () => ({}) as unknown as StreamableHTTPClientTransport,
  );
  // Default: no daemon token on disk for this project. Tests that need a bearer
  // override this AFTER this call (`vi.resetAllMocks()` in beforeEach wipes any
  // earlier implementation).
  vi.mocked(readDaemonToken).mockReturnValue(null);
  return made;
}

/** The Nth constructed fake client; throws when the path built fewer than N+1. */
function clientAt(clients: FakeClient[], n: number): FakeClient {
  const client = clients[n];
  if (client === undefined) {
    throw new Error(`expected at least ${n + 1} client(s), saw ${clients.length}`);
  }
  return client;
}

/** The URL the Nth transport was constructed against. */
function transportUrl(call = 0): string {
  const target = vi.mocked(StreamableHTTPClientTransport).mock.calls[call]?.[0];
  return target instanceof URL ? target.toString() : String(target);
}

/** Install a fake, already-healthy `ensureDaemonRunning` result. */
function installEnsure(): { stop: ReturnType<typeof vi.fn> } {
  const stop = vi.fn(async () => {});
  vi.mocked(ensureDaemonRunning).mockResolvedValue({
    port: CONFIGURED_PORT,
    url: DAEMON_URL,
    started: true,
    stop,
  });
  return { stop };
}

/** A connect implementation that always refuses (the dead-port case). */
function refused(): () => Promise<void> {
  return async () => {
    throw new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:65432');
  };
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

/** Run `fn` and return whatever it threw (fail() throws, never exits). */
async function thrownBy(
  fn: () => Promise<unknown>,
): Promise<{ exitCode?: number; message: string }> {
  try {
    await fn();
  } catch (err) {
    const e = err as { exitCode?: number; message?: string };
    return { exitCode: e.exitCode, message: e.message ?? String(err) };
  }
  throw new Error('expected fn to throw, but it resolved');
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('withDaemon — connect-first on a configured daemon.port', () => {
  it('connects straight to the configured address and never spawns a daemon', async () => {
    const clients = installFakeClients([
      {
        callTool: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, via: 'direct' }) }],
        }),
      },
    ]);

    const payload = await callDaemonTool(portedOpts, 'host_status');

    expect(payload).toEqual({ ok: true, via: 'direct' });
    // The whole point: a daemon was reachable, so NOTHING was spawned. No
    // ensureDaemonRunning call means no daemon started as a side effect.
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    // Exactly one client and one transport: the probe connection IS the
    // connection the command uses (no throwaway probe + redundant reconnect).
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).close).toHaveBeenCalledTimes(1); // closed by withDaemon's finally
    expect(transportUrl()).toBe(`http://127.0.0.1:${CONFIGURED_PORT}/mcp`);
    // The project's own identity is the scope key for the bearer token, exactly
    // as on the ensure path.
    expect(readDaemonToken).toHaveBeenCalledWith(portedProject.id);
  });

  it('spawns only after the direct connect is refused, then retries and succeeds', async () => {
    const clients = installFakeClients([
      { connect: refused() },
      {
        callTool: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, via: 'ensured' }) }],
        }),
      },
    ]);
    const { stop } = installEnsure();

    const payload = await callDaemonTool(portedOpts, 'host_status');

    expect(payload).toEqual({ ok: true, via: 'ensured' });
    // One refused probe, then one spawn, then one retry — in that order.
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).close).toHaveBeenCalledTimes(1); // the dead probe is discarded
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    expect(ensureDaemonRunning).toHaveBeenCalledWith({
      project: portedProject,
      idleTimeoutSec: portedProject.config.daemon.idleTimeoutSec,
      port: CONFIGURED_PORT,
    });
    expect(clientAt(clients, 1).connect).toHaveBeenCalledTimes(1);
    // The spawned daemon's tear-down is still honoured on the new path.
    expect(stop).toHaveBeenCalledTimes(1);
    // First transport targets the CONFIGURED address, the retry targets the
    // address ensureDaemonRunning resolved.
    expect(transportUrl(0)).toBe(`http://127.0.0.1:${CONFIGURED_PORT}/mcp`);
    expect(transportUrl(1)).toBe(DAEMON_URL);
  });

  it('a permanently dead port gives up with the S9 hint instead of hanging (one probe, one spawn, one retry)', async () => {
    const clients = installFakeClients([{ connect: refused() }, { connect: refused() }]);
    const { stop } = installEnsure();

    const err = await thrownBy(() => callDaemonTool(portedOpts, 'host_status'));

    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
    expect(err.message).toBe(DAEMON_DOWN_HINT);
    // BOUNDED: exactly one direct attempt + exactly one retry, ever. A loop
    // (or an unbounded retry) would show up here as a higher count.
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 1).connect).toHaveBeenCalledTimes(1);
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(2);
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    // The failed retry client is closed before the throw — no leaked connection.
    expect(clientAt(clients, 1).close).toHaveBeenCalledTimes(1);
    // Regression (I-1): resolveDaemon throws from here, so withDaemon's finally
    // never runs. The daemon ensureDaemonRunning just STARTED must still be torn
    // down, or it is stranded — running, with no caller left to stop it.
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('bounds the direct probe — a port that never answers falls through instead of stalling', async () => {
    // A "blackhole": the port accepts the connection and never answers, so the
    // probe can only end by its own deadline. Real timers are faked so the test
    // advances that deadline itself — no 5-minute wait, no sleep.
    vi.useFakeTimers();
    try {
      const clients = installFakeClients([
        // `connect` never settles: this is the stall the bound exists for.
        { connect: () => new Promise<void>(() => {}) },
        {
          callTool: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, via: 'ensured' }) }],
          }),
        },
      ]);
      installEnsure();

      const pending = callDaemonTool(portedOpts, 'host_status');
      // Advance by exactly the probe window (+1ms so the deadline is past).
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
      const payload = await pending;

      expect(payload).toEqual({ ok: true, via: 'ensured' });
      // The stall was abandoned for the spawn path rather than waited out.
      expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
      // …and the stalled probe was released, not leaked.
      expect(clientAt(clients, 0).close).toHaveBeenCalledTimes(1);
      expect(clientAt(clients, 1).connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a timed-out probe reports the deadline under --verbose', async () => {
    vi.useFakeTimers();
    try {
      installFakeClients([{ connect: () => new Promise<void>(() => {}) }]);
      installEnsure();

      const out = await captureStderr(async () => {
        const pending = callDaemonTool({ ...portedOpts, verbose: true }, 'host_status');
        await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS + 1);
        await pending;
      });

      expect(out).toMatch(/no daemon at the configured port 65432/);
      expect(out).toMatch(new RegExp(`no response within ${PROBE_TIMEOUT_MS}ms`));
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed spawn after a refused direct connect also gives up with the hint', async () => {
    const clients = installFakeClients([{ connect: refused() }]);
    vi.mocked(ensureDaemonRunning).mockRejectedValue(new Error('no free port'));

    const err = await thrownBy(() => callDaemonTool(portedOpts, 'host_status'));

    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
    expect(err.message).toBe(DAEMON_DOWN_HINT);
    expect(ensureDaemonRunning).toHaveBeenCalledTimes(1);
    // Only the probe was ever constructed (the spawn failed before any retry).
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).close).toHaveBeenCalledTimes(1);
  });

  it('--verbose reports the refused direct connect before falling through to the spawn', async () => {
    installFakeClients([{ connect: refused() }]);
    installEnsure();

    const stderr = await captureStderr(async () => {
      await callDaemonTool({ ...portedOpts, verbose: true }, 'host_status');
    });

    expect(stderr).toMatch(/no daemon at the configured port 65432/);
    expect(stderr).toMatch(/ECONNREFUSED/);
  });

  it('omits the direct-connect diagnostic by default', async () => {
    installFakeClients([{ connect: refused() }]);
    installEnsure();

    const stderr = await captureStderr(async () => {
      await callDaemonTool(portedOpts, 'host_status');
    });

    expect(stderr).not.toMatch(/no daemon at the configured port/);
  });
});

describe('withDaemon — no stable address keeps the ensure-first ordering (spec 7.1)', () => {
  it('no daemon.port configured → ensure runs first and there is no blind probe', async () => {
    const clients = installFakeClients();
    installEnsure();

    await callDaemonTool(baseOpts, 'host_status');

    // Byte-for-byte today's call: the `port` key is absent, not undefined.
    expect(ensureDaemonRunning).toHaveBeenCalledWith({
      project,
      idleTimeoutSec: project.config.daemon.idleTimeoutSec,
    });
    // ONE client, constructed after ensure — there is no address to probe, so
    // no connect is attempted before the spawn decision.
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    expect(transportUrl()).toBe(DAEMON_URL);
  });

  it('a configured port of 0 (ephemeral preference) is not a stable address', async () => {
    const ephemeral: ProjectInfo = {
      ...project,
      config: parseConfig({ host: 'claude', daemon: { port: 0 } }),
    };
    const clients = installFakeClients();
    installEnsure();

    await callDaemonTool({ project: ephemeral }, 'host_status');

    // The preference is still forwarded to the spawn…
    expect(ensureDaemonRunning).toHaveBeenCalledWith({
      project: ephemeral,
      idleTimeoutSec: ephemeral.config.daemon.idleTimeoutSec,
      port: 0,
    });
    // …but nothing is probed: port 0 means "give me an ephemeral port", i.e.
    // explicitly NOT a stable address to connect to first.
    expect(vi.mocked(Client)).toHaveBeenCalledTimes(1);
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    expect(transportUrl()).toBe(DAEMON_URL);
  });
});

describe('withWorkspaceDaemon — probe-only, never auto-starts (ADR-0009 §11)', () => {
  /** A workspace routing pair for a project whose config pins a daemon port. */
  const routing = { name: 'ws-demo', projectId: portedProject.id };

  it('a down workspace daemon fails with guidance and starts nothing', async () => {
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue(null);

    // NOTE the opts: the project HAS a configured `daemon.port`, so this also
    // proves the connect-first activation path is never reached from the
    // workspace route — a workspace daemon that is down must fail, not spawn.
    const stderr = await captureStderr(async () => {
      const err = await thrownBy(() =>
        withWorkspaceDaemon(portedOpts, routing, async () => 'unreachable'),
      );
      expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
      expect(err.message).toMatch(/is not running/);
      expect(err.message).toMatch(/noir daemon start --workspace ws-demo/);
    });
    expect(stderr).toMatch(/is not running/);

    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(vi.mocked(Client)).not.toHaveBeenCalled();
    expect(vi.mocked(StreamableHTTPClientTransport)).not.toHaveBeenCalled();
  });

  it('a stale workspace record (dead pid) also fails instead of starting one', async () => {
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue({
      pid: 999_999,
      port: CONFIGURED_PORT,
      startedAt: Date.now(),
      workspace: 'ws-demo',
    });
    vi.mocked(pidAlive).mockReturnValue(false);

    const err = await thrownBy(() =>
      withWorkspaceDaemon(portedOpts, routing, async () => 'unreachable'),
    );

    expect(err.exitCode).toBe(EXIT.DAEMON_DOWN);
    expect(err.message).toMatch(/is not running/);
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(vi.mocked(Client)).not.toHaveBeenCalled();
  });

  it('a live workspace daemon still connects directly (the happy path is unchanged)', async () => {
    vi.mocked(readWorkspaceDaemonRecord).mockReturnValue({
      pid: process.pid,
      port: CONFIGURED_PORT,
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
    const clients = installFakeClients([
      {
        callTool: async () => ({
          content: [{ type: 'text', text: JSON.stringify({ ok: true, memories: [] }) }],
        }),
      },
    ]);

    const payload = await withWorkspaceDaemon(portedOpts, routing, (caller) =>
      caller.callTool('memory_recall'),
    );

    expect(payload).toEqual({ ok: true, memories: [] });
    expect(clientAt(clients, 0).connect).toHaveBeenCalledTimes(1);
    // Still probe-only on the way in: the probe decides, the connect follows.
    expect(ensureDaemonRunning).not.toHaveBeenCalled();
    expect(transportUrl()).toBe(`http://127.0.0.1:${CONFIGURED_PORT}/mcp?p=${portedProject.id}`);
  });
});
