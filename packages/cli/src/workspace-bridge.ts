// The workspace stdio bridge.
//
// A repository that joined a shared workspace is served by that workspace's
// daemon — a separate process holding the workspace store, reached over HTTP
// with a bearer token. The host knows nothing of that: it starts the plain
// stdio command (`noir mcp serve --stdio --workspace <name>`), and this module
// turns that into a connection to the daemon. It resolves the daemon's address
// and secret from disk, proves through `/health` that the process answering
// really is that workspace's daemon (a recycled pid or a stale record must
// never be trusted), and then relays JSON-RPC messages in both directions.
//
// Two properties shape the relay. It is transparent — the host performs the MCP
// handshake and every call with the daemon directly, so there is no tool surface
// here to drift from the daemon's. And stdout carries nothing but the host's
// protocol traffic: diagnostics go to stderr, and the token goes only into the
// HTTP authorization header, never into a stream or a config file.

import type { Readable, Writable } from 'node:stream';
import {
  type JSONRPCMessage,
  ReadBuffer,
  StreamableHTTPClientTransport,
  serializeMessage,
  type Transport,
} from '@modelcontextprotocol/client';
import { loadProjectInfo } from '@noir-ai/core';
import { pidAlive, readDaemonToken, readWorkspaceDaemonRecord, tokenPath } from '@noir-ai/daemon';
import { EXIT, fail } from './output.js';

/**
 * How long a `/health` probe may take. A record can point at a port that an
 * unrelated process holds open without ever answering, and a host waiting on
 * its MCP server must not hang there. The bridge probes once — there is no retry
 * loop — so this bound is the whole wait.
 */
const HEALTH_PROBE_TIMEOUT_MS = 1500;

/**
 * Resolve a workspace's daemon to a connect URL and its bearer token, or to a
 * precise reason it cannot be reached.
 *
 * `root` is the caller's repository: the workspace daemon authorises each
 * request against the member id carried in the URL, and stores this session's
 * writes under it.
 */
export async function resolveWorkspaceDaemon(
  name: string,
  root: string,
): Promise<{ url: string; token: string } | { error: string }> {
  const record = readWorkspaceDaemonRecord(name);
  if (record === null) {
    return { error: `no daemon recorded for workspace ${name}` };
  }
  if (!pidAlive(record.pid)) {
    return { error: `record exists but the daemon is not answering (pid ${record.pid})` };
  }

  const health = await probeHealth(record.port, name, record.pid);
  if (health.kind === 'foreign') {
    // A different workspace answering here is the sharper diagnosis, so name
    // both sides — it tells the reader which record is the stale one.
    return {
      error:
        `workspace ${name} is recorded on port ${record.port}, but the daemon ` +
        `answering there serves workspace ${health.workspace}`,
    };
  }
  if (health.kind === 'silent') {
    return { error: `record exists but the daemon is not answering (pid ${record.pid})` };
  }

  const token = readDaemonToken(name);
  if (token === null) {
    // Name the file, never a value: a token is a credential, and the remedy for
    // an unreadable file does not depend on knowing its contents.
    return {
      error: `workspace ${name} daemon is answering but its token is unreadable at ${tokenPath(name)}`,
    };
  }

  let callerProjectId: string;
  try {
    callerProjectId = loadProjectInfo(root).id;
  } catch {
    return {
      error: `no project identity in ${root} — run \`noir init\` before serving a workspace from here`,
    };
  }

  return { url: `http://127.0.0.1:${record.port}/mcp?p=${callerProjectId}`, token };
}

/**
 * What a `/health` probe learned. `silent` covers every way an answer can fail
 * to identify the recorded daemon — no connection, a non-2xx status, a body that
 * is not JSON, or a body that names a different process — because all of them
 * mean the same thing to the caller: this record cannot be used.
 */
type HealthOutcome =
  | { kind: 'healthy' }
  | { kind: 'silent' }
  | { kind: 'foreign'; workspace: string };

/**
 * Ask a recorded port who it is, within the bounded window.
 *
 * The answer is accepted only when it carries the recorded pid back: a port can
 * be reused by an unrelated process that answers `/health` perfectly well, and
 * that process must not be handed this workspace's traffic.
 */
async function probeHealth(port: number, name: string, pid: number): Promise<HealthOutcome> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { kind: 'silent' };
    const body = (await response.json().catch(() => null)) as {
      ok?: unknown;
      pid?: unknown;
      workspace?: unknown;
    } | null;
    if (body === null) return { kind: 'silent' };
    if (typeof body.workspace === 'string' && body.workspace !== name) {
      return { kind: 'foreign', workspace: body.workspace };
    }
    if (body.ok !== true || body.pid !== pid) return { kind: 'silent' };
    return { kind: 'healthy' };
  } catch {
    return { kind: 'silent' };
  }
}

/**
 * Serve the host over stdio by relaying every message to the workspace daemon.
 *
 * Resolving or connecting can fail; both are reported on stderr with the
 * daemon-down exit code, because a host that cannot reach its server must see a
 * failure rather than a server that silently answers nothing.
 */
export async function bridgeStdioToWorkspace(name: string, root: string): Promise<void> {
  const resolved = await resolveWorkspaceDaemon(name, root);
  if ('error' in resolved) {
    fail(EXIT.DAEMON_DOWN, resolved.error);
  }

  const host = new StdioBridgeTransport(process.stdin, process.stdout);
  const daemon = new StreamableHTTPClientTransport(new URL(resolved.url), {
    requestInit: { headers: { Authorization: `Bearer ${resolved.token}` } },
  });

  try {
    await relay(host, daemon);
  } finally {
    // Whichever side ended the session, neither transport is left open.
    await daemon.close().catch(() => {});
    await host.close().catch(() => {});
  }
}

/**
 * Wire the two transports together and settle when the session ends.
 *
 * Both directions are live: what the host sends goes to the daemon, and what the
 * daemon sends goes to the host. Either side closing closes the other, so a host
 * that has gone leaves no connection behind and the process can exit. Both
 * transports start only after every handler is installed, so a message that
 * races the start is never dropped.
 */
async function relay(host: StdioBridgeTransport, daemon: Transport): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };

    host.onmessage = (message) => {
      // A send that fails is terminal for the session — the daemon is gone or
      // refused the message, and relaying anything further would report a
      // success the host cannot trust.
      void daemon.send(message).catch(() => {
        void daemon.close().catch(() => {});
      });
    };
    host.onclose = () => {
      void daemon.close().catch(() => {});
      settle();
    };
    host.onerror = () => {
      void daemon.close().catch(() => {});
      settle();
    };

    daemon.onmessage = (message) => {
      void host.send(message).catch(() => {});
    };
    daemon.onclose = () => {
      void host.close().catch(() => {});
      settle();
    };
    daemon.onerror = (error) => {
      // Reported, never fatal on its own: the transport also rejects the send
      // that caused it, and that path closes the session.
      process.stderr.write(
        `noir: workspace bridge: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    };

    const failStart = (error: Error): void => {
      host.onerror?.(error);
      void daemon.close().catch(() => {});
      settle();
    };
    void daemon.start().catch(failStart);
    void host.start().catch(failStart);
  });
}

/**
 * The host-facing half of the bridge: an MCP transport that reads JSON-RPC
 * messages from stdin and writes them to stdout.
 *
 * The framing (newline-delimited messages, buffered reads, backpressure-aware
 * writes) mirrors the stdio transport that ships with the MCP server package,
 * which the CLI cannot import — it depends on the client package only, and the
 * bridge is the one place the CLI hosts a stdio server of its own.
 */
class StdioBridgeTransport implements Transport {
  onclose?: (() => void) | undefined;
  onerror?: ((error: Error) => void) | undefined;
  onmessage?: ((message: JSONRPCMessage) => void) | undefined;

  private readonly buffer = new ReadBuffer();
  private started = false;
  private closed = false;

  constructor(
    private readonly stdin: Readable,
    private readonly stdout: Writable,
  ) {}

  async start(): Promise<void> {
    if (this.started) throw new Error('the stdio bridge transport is already started');
    this.started = true;
    this.stdin.on('data', this.onData);
    this.stdin.on('error', this.onStdinFault);
    this.stdin.on('end', this.onStdinEnd);
    this.stdout.on('error', this.onStdoutFault);
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the stdio bridge transport is closed'));
    return new Promise<void>((resolve, reject) => {
      // Backpressure: `write` returns false once the kernel buffer is full, and
      // waiting for `drain` keeps a burst of daemon responses from growing this
      // process's memory without bound.
      if (this.stdout.write(serializeMessage(message))) {
        resolve();
        return;
      }
      const onDrain = (): void => {
        this.stdout.off('error', onWriteError);
        resolve();
      };
      const onWriteError = (error: Error): void => {
        this.stdout.off('drain', onDrain);
        reject(error);
      };
      this.stdout.once('drain', onDrain);
      this.stdout.once('error', onWriteError);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stdin.off('data', this.onData);
    this.stdin.off('error', this.onStdinFault);
    this.stdin.off('end', this.onStdinEnd);
    this.stdout.off('error', this.onStdoutFault);
    this.buffer.clear();
    // Nothing is listening to stdin any more; releasing it is what lets a
    // host-spawned bridge process exit rather than sit on a paused read.
    if (this.stdin.listenerCount('data') === 0) this.stdin.pause();
    this.onclose?.();
  }

  private readonly onData = (chunk: Buffer): void => {
    try {
      this.buffer.append(chunk);
      for (;;) {
        const message = this.buffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      }
    } catch (error) {
      // A message that cannot be parsed ends the session: the host's stream is
      // out of sync from here on, and guessing at the rest would relay garbage.
      this.onerror?.(toError(error));
      void this.close();
    }
  };

  /** The host closed its end of the pipe — the session is over. */
  private readonly onStdinEnd = (): void => {
    void this.close();
  };

  private readonly onStdinFault = (error: Error): void => {
    this.onerror?.(error);
    void this.close();
  };

  private readonly onStdoutFault = (error: Error): void => {
    this.onerror?.(error);
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
