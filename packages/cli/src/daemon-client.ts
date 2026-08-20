// S9 t3 — Daemon MCP client.
//
// Store-touching commands (`status`, `context *`, `memory *`, `task *`) are thin
// MCP clients over the running Noir daemon rather than opening the store
// in-process: that preserves the daemon's single-writer discipline and reuses
// the MCP tool surface built in S6. This module is the single bridge from
// the CLI to that daemon — every command module calls {@link callDaemonTool} (or
// the multi-call {@link withDaemon}) instead of importing the store directly.
//
// Flow: {@link ensureDaemonRunning} (from @noir-ai/daemon) reads the daemon
// record at `~/.noir/daemon.json` (NOIR_DAEMON_JSON override for tests) and
// STARTS a foreground daemon if no healthy one is present, returning its URL +
// a `stop()` tear-down. We connect a @modelcontextprotocol/client `Client` over
// Streamable HTTP to that URL (127.0.0.1 only — daemon §4), initialize, and
// `callTool(name, args)`; the daemon's tools always return a single text content
// block whose `text` is `JSON.stringify(payload)` (see `textResult` in
// packages/daemon/src/server.ts), so we parse it back into the payload object.
//
// Failure handling (S9 exit-code contract): ANY failure to reach or use the
// daemon — record missing/stale, ensure-start error, transport, connect,
// protocol, or a tool call that rejects / returns no parseable text — maps to
// exit code `4` (DAEMON_DOWN) with a stable remediation hint. `--verbose` surfaces
// the underlying cause on stderr; `--json` shapes the failure as the S9
// `{ok:false,error:{code,message}}` envelope ON STDOUT via `output.ts:fail`
// (data→stdout discipline — the single canonical envelope is shaped once there;
// `failDaemonDown` passes the PLAIN hint as the message, never a pre-stringified
// inner envelope, which would doubly-encode `error.message`). A tool that returns
// a logical-failure envelope (`{ok:false, degraded:true, …}`) is NOT a transport
// failure — it parses cleanly and is returned to the caller as data.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ContextEngine, createEmbedFn, resolveEmbedderConfig } from '@noir-ai/context';
import { loadProjectInfo, NOIR_VERSION, type ProjectInfo } from '@noir-ai/core';
import {
  ensureDaemonRunning,
  pidAlive,
  readDaemonRecord,
  resolveGateConfig,
} from '@noir-ai/daemon';
import { createMemoryEngine, type MemoryEngine } from '@noir-ai/memory';
import { openStore } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';
import { EXIT, fail } from './bin.js';

/** Options shared by every daemon-client entry point. */
export interface DaemonClientOptions {
  /** Emit the daemon-down failure as a JSON `{ok,error}` envelope (S9 --json). */
  readonly json?: boolean;
  /** Surface transport / connection detail on stderr (S9 --verbose). */
  readonly verbose?: boolean;
  /**
   * Project used to resolve the daemon idle timeout. Defaults to
   * `loadProjectInfo(process.cwd())` — the bin's `--cwd` preAction hook has
   * already chdir'd, so process.cwd() honors `--cwd`.
   */
  readonly project?: ProjectInfo;
  /** Override the daemon idle timeout (sec). Defaults to the project's config. */
  readonly idleTimeoutSec?: number;
}

/** A handle for calling daemon MCP tools over an already-connected client. */
export interface DaemonToolCaller {
  /**
   * Call a daemon MCP tool and parse its text-JSON result. Transport / parse
   * failures throw an S9 {@link NoirCliError} (exit 4); a tool's own logical
   * failure envelope (`{ok:false,…}`) is returned as-is.
   */
  callTool<T = unknown>(name: string, args?: Record<string, unknown>): Promise<T>;
  /**
   * List the names of the tools the connected daemon currently exposes.
   * Required so a command can tell "the daemon is up but does not register
   * tool X" (an opt-in / engine-not-wired condition, e.g. `memory_consolidate`
   * when consolidation is disabled) apart from "the daemon is down" — calling
   * an unregistered tool would otherwise mis-map onto exit 4 (DAEMON_DOWN).
   * Transport failures throw exit 4 exactly like {@link callTool}.
   */
  listTools(): Promise<string[]>;
}

/** Daemon-down remediation hint (S9). Stable across releases. */
export const DAEMON_DOWN_HINT = 'daemon not reachable — try `noir daemon start`';

/**
 * Bounded /health probe window (ms). A probe must never hang: a stale daemon
 * record can point at a port bound by an unrelated process that accepts TCP but
 * never answers, and the probe is now the FIRST hop for every read command's
 * fallback decision. A timeout is treated as "not running" (reads degrade to the
 * read-only engine); the bound also keeps the daemon-up fast path snappy.
 */
export const PROBE_TIMEOUT_MS = 1500;

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/**
 * Map any daemon / transport failure onto the S9 DAEMON_DOWN exit code. Always
 * throws (via {@link fail}); the `never` return lets callers use it as a
 * diverging expression inside parsed result handling.
 */
function failDaemonDown(opts: DaemonClientOptions, cause: unknown): never {
  if (opts.verbose) {
    process.stderr.write(`noir: daemon transport detail: ${describeCause(cause)}\n`);
  }
  // Pass the PLAIN hint + opts and let `output.ts:fail` shape the single S9
  // `{ok:false,error:{code:EXIT.DAEMON_DOWN,message:hint}}` envelope ONCE. The
  // prior branch pre-stringified an inner `{ok,error}` and passed it as `message`,
  // which `fail` then wrapped AGAIN → `error.message` was a JSON string
  // (doubly-encoded). `opts` carries `--json`/`--verbose` so `fail` selects the
  // stdout envelope vs. the plain stderr line.
  fail(EXIT.DAEMON_DOWN, DAEMON_DOWN_HINT, opts);
}

// ---------------------------------------------------------------------------
// Liveness probe (read-only). `noir status` uses this to report daemon state
// HONESTLY without auto-starting one: it reads the daemon record + checks the
// pid + GETs /health, and returns {running:false} on any miss. It NEVER calls
// ensureDaemonRunning. Active commands keep using {@link withDaemon} (which may
// start a daemon); only the informational `status` command is probe-only.
// ---------------------------------------------------------------------------

/** Outcome of a read-only daemon liveness probe (never starts a daemon). */
export interface DaemonProbe {
  running: boolean;
  pid?: number;
  port?: number;
  uptimeSec?: number;
}

/**
 * Probe whether a healthy daemon is currently running, WITHOUT starting one.
 * Reads the daemon record (`~/.noir/daemon.json` via {@link readDaemonRecord}),
 * checks {@link pidAlive}, and GETs `http://127.0.0.1:<port>/health`. Any miss
 * (no record, stale pid, non-200, unreachable, malformed body) → `{running:false}`
 * — this function NEVER throws and NEVER starts a daemon. Under `--verbose` the
 * reason for a miss is logged to stderr (NF5: honest degradation).
 */
export async function probeDaemon(opts: DaemonClientOptions = {}): Promise<DaemonProbe> {
  const rec = readDaemonRecord();
  if (!rec) {
    if (opts.verbose) process.stderr.write('noir: daemon probe: no daemon record\n');
    return { running: false };
  }
  if (!pidAlive(rec.pid)) {
    if (opts.verbose) process.stderr.write(`noir: daemon probe: pid ${rec.pid} not alive\n`);
    return { running: false };
  }
  try {
    // Bounded probe: a stale daemon record pointing at a port held by an
    // unrelated process that accepts TCP but never responds (a blackhole) must
    // NOT hang the probe (or any read command that probes first). Treat a
    // timeout as "not running" so reads fall back to the read-only engine.
    const res = await fetch(`http://127.0.0.1:${rec.port}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) {
      if (opts.verbose) process.stderr.write(`noir: daemon probe: /health → HTTP ${res.status}\n`);
      return { running: false };
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      pid?: number;
      uptimeSec?: number;
    } | null;
    if (body?.ok !== true) {
      if (opts.verbose) process.stderr.write('noir: daemon probe: /health body not ok\n');
      return { running: false };
    }
    return {
      running: true,
      pid: typeof body.pid === 'number' ? body.pid : rec.pid,
      port: rec.port,
      uptimeSec: typeof body.uptimeSec === 'number' ? body.uptimeSec : undefined,
    };
  } catch (err) {
    if (opts.verbose)
      process.stderr.write(`noir: daemon probe: unreachable (${describeCause(err)})\n`);
    return { running: false };
  }
}

/**
 * Ensure a healthy daemon is running and return its MCP URL + a tear-down
 * callback. Maps any start / record error onto exit 4.
 */
async function resolveDaemon(
  opts: DaemonClientOptions,
): Promise<{ url: string; stop: () => Promise<void> }> {
  // Lazy default: when the caller didn't inject a project (the common case from
  // command modules, which only forward --json/--verbose), resolve one here.
  // An uninitialized project (`loadProjectInfo` throws "Run `noir init` first")
  // is a USAGE error (exit 1), not a daemon-down (exit 4) — so route it through
  // fail() BEFORE the ensureDaemonRunning try, which maps errors to exit 4. This
  // keeps exit-1 semantics AND emits the canonical {ok:false,error} envelope on
  // stdout under --json (a plain Error would leave stdout EMPTY).
  let project: ProjectInfo;
  try {
    project = opts.project ?? loadProjectInfo(process.cwd());
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }
  const idleTimeoutSec = opts.idleTimeoutSec ?? project.config.daemon.idleTimeoutSec;
  try {
    const ensured = await ensureDaemonRunning({ project, idleTimeoutSec });
    return { url: ensured.url, stop: ensured.stop };
  } catch (err) {
    failDaemonDown(opts, err);
  }
}

/** Connect a Client over Streamable HTTP; map transport failure to exit 4. */
async function connectClient(
  client: Client,
  url: string,
  opts: DaemonClientOptions,
): Promise<void> {
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  } catch (err) {
    failDaemonDown(opts, err);
  }
}

/**
 * Call one daemon tool and parse its text-JSON result. A tool's own
 * logical-failure envelope is returned as data; transport / parse failures
 * throw exit 4.
 */
async function callToolParse<T>(
  client: Client,
  opts: DaemonClientOptions,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  // `.catch` whose handler returns `never` (failDaemonDown always throws) keeps
  // `result` typed as the callTool payload — no evolving-any `let`, and the only
  // way past this line is a successful call.
  const result = await client
    .callTool({ name, arguments: args })
    .catch((err: unknown) => failDaemonDown(opts, err));
  // The daemon's tools always return `{content:[{type:'text', text: JSON}]}` via
  // `textResult`. Read defensively: any non-text / empty / non-JSON block means
  // the MCP surface is unusable → exit 4 (not a tool's logical error).
  const block = (result.content as readonly unknown[] | undefined)?.[0] as
    | { type?: string; text?: unknown }
    | undefined;
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    failDaemonDown(opts, new Error(`tool '${name}' returned no text content`));
  }
  const text: string = block.text;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    failDaemonDown(opts, err);
  }
}

/**
 * Connect to the daemon and run `fn` against a {@link DaemonToolCaller} that
 * shares one MCP connection across any number of tool calls. The client is
 * closed and any daemon this call started is torn down in `finally`, even when
 * `fn` throws — so a one-shot CLI command never strands a server or leaks a
 * connection, while a reused (already-running) daemon is left untouched
 * (`ensureDaemonRunning`'s `stop` is a no-op in that case).
 *
 * `fn`'s own errors propagate untouched (the command module owns their exit
 * code); only transport / connection / tool-parse failures map to exit 4 here.
 */
/**
 * Build a {@link DaemonToolCaller} over an already-connected {@link Client}.
 * Shared by {@link withDaemon} (active commands — failures map to exit 4) and
 * {@link withRunningDaemon} (status — connect failures degrade to null, caught
 * by its outer try). `callTool`/`listTools` still route transport / parse
 * failures through {@link failDaemonDown}; {@link withRunningDaemon} wraps the
 * connect+fn body so those become a null result instead of an exit.
 */
function buildCaller(client: Client, opts: DaemonClientOptions): DaemonToolCaller {
  return {
    callTool: <U = unknown>(name: string, args: Record<string, unknown> = {}): Promise<U> =>
      callToolParse<U>(client, opts, name, args),
    listTools: async (): Promise<string[]> => {
      // `listTools()` is the standard MCP capability discovery method; the
      // daemon's McpServer answers with every registered tool name. Any
      // transport failure maps to exit 4 (DAEMON_DOWN) exactly like callTool;
      // a defensive read of `.tools` keeps a surprising payload from crashing.
      const res = await client.listTools().catch((err: unknown) => failDaemonDown(opts, err));
      const tools = (res as { tools?: unknown } | null)?.tools;
      if (!Array.isArray(tools)) return [];
      const names: string[] = [];
      for (const t of tools) {
        const name = (t as { name?: unknown } | null)?.name;
        if (typeof name === 'string') names.push(name);
      }
      return names;
    },
  };
}

export async function withDaemon<T>(
  opts: DaemonClientOptions,
  fn: (caller: DaemonToolCaller) => Promise<T>,
): Promise<T> {
  const { url, stop } = await resolveDaemon(opts);
  let client: Client | undefined;
  try {
    client = new Client(
      { name: 'noir-cli', version: NOIR_VERSION },
      { versionNegotiation: { mode: 'auto' } },
    );
    // Capture the now-definitely-assigned client BEFORE any `await` so buildCaller
    // sees `Client` (not `Client | undefined`) without relying on how TS narrows a
    // `let` across an await.
    const connected: Client = client;
    await connectClient(connected, url, opts);
    return await fn(buildCaller(connected, opts));
  } finally {
    if (client) {
      await client.close().catch(() => {
        /* a close error must not mask the real failure / swallowed result */
      });
    }
    await stop().catch(() => {
      /* ditto: tear-down failures never override the command's outcome */
    });
  }
}

/**
 * Connect to an ALREADY-RUNNING daemon (located via {@link probeDaemon}) and run
 * `fn` over one MCP connection. NEVER starts a daemon — returns `null` when the
 * probe finds none. This is the read-only, best-effort path `noir status` uses:
 * a down daemon is reported honestly (the caller renders `daemon:{running:false}`
 * and exits 0 — status is informational, not a write), and any connect failure
 * that crops up after a successful probe (the daemon died mid-snapshot) degrades
 * to `null` rather than escalating to exit 4 (DAEMON_DOWN). Active commands that
 * NEED a daemon use {@link withDaemon} (which auto-starts + maps failures to
 * exit 4); only `status` is probe-only.
 *
 * `fn` should wrap its own tool calls in a try/catch (status uses `tryTool`) so a
 * single missing engine folds to `null` instead of failing the snapshot.
 *
 * `probe` lets a caller that has ALREADY probed (status, to populate the daemon
 * section whether up or down) pass the result in so we don't GET /health twice.
 */
export async function withRunningDaemon<T>(
  opts: DaemonClientOptions,
  fn: (caller: DaemonToolCaller) => Promise<T>,
  probe?: DaemonProbe,
): Promise<T | null> {
  const p = probe ?? (await probeDaemon(opts));
  if (!p.running) return null;
  const url = `http://127.0.0.1:${p.port}/mcp`;
  let client: Client | undefined;
  try {
    client = new Client(
      { name: 'noir-cli', version: NOIR_VERSION },
      { versionNegotiation: { mode: 'auto' } },
    );
    const connected: Client = client;
    // Connect directly to the probed port — NO ensureDaemonRunning. If the daemon
    // died between probe and connect (a race), this throws and we degrade to null
    // (the probe already supplied pid/uptime for the snapshot).
    await connected.connect(new StreamableHTTPClientTransport(new URL(url)));
    return await fn(buildCaller(connected, opts));
  } catch {
    // Best-effort: probe said up but connect/transport failed mid-snapshot.
    // Report the probe data + null sections instead of exit 4.
    return null;
  } finally {
    if (client) {
      await client.close().catch(() => {
        /* a close error must not mask the degraded result */
      });
    }
  }
}

/**
 * Call a single daemon MCP tool and return its parsed JSON payload. The
 * convenience most command modules use; built on {@link withDaemon} so connect
 * + close + tear-down are handled once.
 */
export async function callDaemonTool<T = unknown>(
  opts: DaemonClientOptions,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  return withDaemon<T>(opts, (caller) => caller.callTool<T>(name, args));
}

// ---------------------------------------------------------------------------
// In-process read-only fallback (S9 DS-5). READS only — the single-writer
// invariant is preserved because the store is opened READ-ONLY and every engine
// built over it (context retriever, memory recall/sessions, workflow status) is
// a pure reader. Writes keep the daemon-required path (exit 4 when down).
// ---------------------------------------------------------------------------

/** Engines constructed in-process by {@link withInProcessRead} (reads only). */
export interface InProcessEngines {
  /** Hybrid-retrieval engine over the read-only store handle. */
  context: ContextEngine;
  /** Cross-session memory engine over the same handle (recall/sessions read). */
  memory: MemoryEngine;
  /** Workflow engine over the same handle (status read). */
  workflow: WorkflowEngine;
}

/**
 * Open the project's store READ-ONLY, build the context + memory + workflow
 * engines in-process over that one handle, run `fn`, and close the store in
 * `finally`. This is the daemon-down fallback for READ commands (`context
 * search`, `memory recall`, `memory sessions`, `task status`): a read-only
 * handle preserves the daemon's single-writer discipline (the store is never
 * opened for writes here), and reads (FTS, kNN, counts, KV) keep working on it
 * exactly as they do for a degraded daemon handle.
 *
 * Construction mirrors {@link openStoreForDaemon} + the daemon's stdio/http
 * seams: the context engine resolves its embedder from the project's
 * `context:` config via {@link resolveEmbedderConfig} (a pure projection —
 * construction never touches the network or the native runtime; a `kind:'none'`
 * or unavailable embedder degrades reads to BM25-only, F8); the memory engine
 * shares the SAME embed; the workflow engine reads the store KV. All three
 * reuse the injected handle — no second connection.
 *
 * `storeDegraded: true` is threaded into both engines so their persistent
 * `degraded` flag is honest (a read-only handle) and any accidental write
 * refuses with the daemon's "store is read-only (daemon down)" error rather
 * than silently succeeding.
 *
 * The store is ALWAYS closed in `finally`, even when `fn` throws (a one-shot
 * CLI command never strands a handle).
 *
 * @param opts Daemon-client options. `project` resolves the store path + the
 *   embedder config; when absent it is resolved from `process.cwd()`
 *   (uninitialized project → throws the "Run `noir init` first" exit-1 hint,
 *   mirroring {@link resolveDaemon}).
 */
export async function withInProcessRead<T>(
  opts: DaemonClientOptions,
  fn: (engines: InProcessEngines) => Promise<T>,
): Promise<T> {
  let project: ProjectInfo;
  try {
    project = opts.project ?? loadProjectInfo(process.cwd());
  } catch {
    fail(EXIT.ERROR, 'Noir is not initialized in this directory. Run `noir init` first.', opts);
  }
  const store = await openStore({ projectId: project.id, root: project.root, readonly: true });
  try {
    // READ-ONLY handle: `storeDegraded` is threaded so status/degraded flags are
    // honest and any accidental write refuses cleanly (single writer preserved).
    const embedderCfg = resolveEmbedderConfig(project.config.context);
    const embed = createEmbedFn(embedderCfg).embed;
    const context = new ContextEngine({
      store,
      root: project.root,
      projectId: project.id,
      embedderCfg,
      storeDegraded: true,
    });
    const memory = createMemoryEngine({
      store,
      root: project.root,
      projectId: project.id,
      embed,
      storeDegraded: true,
    });
    const workflow = new WorkflowEngine(
      store,
      project.root,
      project.id,
      resolveGateConfig(project.config),
    );
    return await fn({ context, memory, workflow });
  } finally {
    await store.close().catch(() => {
      /* a close error must not mask the command's outcome */
    });
  }
}
