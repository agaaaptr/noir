// S9 t4 — `noir status [--json]`.
//
// Aggregates a project + daemon + store + context + workflow + memory snapshot.
// Project info (id/name/host/version) is assembled IN-PROCESS from
// `loadProjectInfo` + `NOIR_VERSION` — no daemon round-trip just to name the
// project. Daemon state comes from a read-only {@link probeDaemon} (liveness
// probe of `~/.noir/daemon.json` + pid + GET /health) that NEVER starts a daemon
// (spec F2 amendment: `status` is probe-only and works daemon-down — a down
// daemon is reported honestly + exit 0, never auto-started). When the probe finds
// a running daemon, the optional count tools are fetched over one connection via
// {@link withRunningDaemon} (which reuses the running daemon and also never
// starts one); if the daemon is down, those sections are simply `null` and the
// snapshot still renders.
//
// Graceful degradation (spec F2 / "some engines optional"): every count tool —
// `host_status` (enriches `daemon.transport`), `store_status`, `context_status`,
// `workflow_status`, `memory_sessions` — is wrapped in {@link tryTool} and
// contributes `null` when absent or when its engine is not wired. One missing
// engine never fails the snapshot; even the daemon being down doesn't (it is the
// one piece of information `status` exists to report). A tool's own
// logical-failure envelope (e.g. `workflow_status` returning
// `{ok:false,error:'no active task'}`) is data, not a transport failure, and is
// normalized to `null`.
//
// Active commands (`context *`, `memory *`, `task *`) do real work and KEEP using
// `withDaemon` (auto-start acceptable for commands that perform writes/reads with
// side-effects); their daemon-down path is the same clean exit-4 envelope. Only
// `status` is probe-only — in-process read fallback for the active commands is
// deferred to v1.x.
//
// Stream discipline (S9): `--json` emits the versioned `{ok,data}` envelope
// to STDOUT (the only stdout write); the human table + banner go to STDERR via
// the centralized `table()` / `log()` helpers (auto-stripped under NO_COLOR /
// non-TTY / --json).

import { loadProjectInfo, NOIR_VERSION, type ProjectInfo } from '@noir-ai/core';
import {
  type DaemonClientOptions,
  type DaemonProbe,
  type DaemonToolCaller,
  probeDaemon,
  withRunningDaemon,
} from '../daemon-client.js';
import { type CliOptions, definitionList, log } from '../output.js';
import { badge } from '../theme.js';

/** Options accepted by `status` (global flags + daemon-client knobs). */
export interface StatusOptions extends CliOptions, DaemonClientOptions {}

// ---------------------------------------------------------------------------
// Tool result shapes (the relevant slices of the daemon's payloads). The daemon
// returns these as JSON text; daemon-client parses them to `unknown`, so each
// reader below treats a missing/foreign field as `undefined` and the section is
// reported `null`. Keeping these local (rather than importing the daemon's
// internal types) means the CLI depends only on the MCP wire contract.
// ---------------------------------------------------------------------------
interface HostStatusResult {
  noir: string;
  project: { id: string; name: string };
  host: string;
  transport: string;
  daemon: boolean;
  pid?: number;
  uptimeSec?: number;
}

interface StoreStatusResult {
  ok: boolean;
  projectId: string;
  docCount: number;
  vecCount: number;
  dbPath: string | null;
  degraded: boolean;
}

interface ContextStatusResult {
  ok: boolean;
  projectId: string;
  docCount: number;
  vecCount: number;
  indexedFiles: number;
  embedder: { kind: string; model?: string; dim: number };
  degraded: boolean;
}

interface WorkflowStatusResult {
  ok: boolean;
  taskId: string;
  phase: string;
  state: string;
  mode: string;
  nextGate: string | null;
  degraded: boolean;
}

interface MemorySessionsResult {
  ok: boolean;
  sessions: Array<{ id: string; count: number; lastTs: number }>;
}

// ---------------------------------------------------------------------------
// Normalized payload (the `data` of the `--json` envelope + the source for the
// human table). Every optional section is `null` when its engine is absent, so
// a `--json` consumer can branch with a simple null check.
// ---------------------------------------------------------------------------
export interface StatusPayload {
  noir: string;
  project: { id: string; name: string };
  host: string;
  daemon: {
    running: boolean;
    transport?: string;
    pid?: number;
    uptimeSec?: number;
  };
  store: {
    docCount: number;
    vecCount: number;
    dbPath: string | null;
    degraded: boolean;
  } | null;
  context: {
    docCount: number;
    vecCount: number;
    indexedFiles: number;
    embedder: string;
    degraded: boolean;
  } | null;
  workflow: {
    taskId: string;
    phase: string;
    state: string;
    mode: string;
    nextGate: string | null;
    degraded: boolean;
  } | null;
  memory: { sessions: number; observations: number } | null;
}

/**
 * Call an optional daemon tool, returning `null` on ANY failure. The daemon
 * registers `store_status` / `context_status` / `workflow_status` /
 * `memory_sessions` only when it wired the matching engine, so a missing engine
 * surfaces as a tool-call failure that we fold to `null` rather than failing
 * the snapshot. A tool's own `{ok:false,…}` envelope is returned as data (the
 * caller normalizes it) — only transport / parse / not-registered failures map
 * to `null` here.
 *
 * Exported so `noir handoff` reuses the SAME fold-to-null pattern for its
 * bounded `context_search` / `memory_recall` extraction — a missing embedder or
 * a daemon-down degrades to `null` instead of failing the handoff artifact.
 */
export async function tryTool<T>(
  caller: DaemonToolCaller,
  name: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  try {
    return await caller.callTool<T>(name, args);
  } catch {
    // Engine absent (tool not registered), transport hiccup, or non-JSON text.
    // All are non-fatal for an optional section; report it as unavailable.
    return null;
  }
}

function pickStore(s: StoreStatusResult | null): StatusPayload['store'] {
  if (s?.ok !== true) return null;
  return {
    docCount: s.docCount,
    vecCount: s.vecCount,
    dbPath: s.dbPath,
    degraded: s.degraded === true,
  };
}

function describeEmbedder(e: ContextStatusResult['embedder']): string {
  if (!e || e.kind === 'none') return 'none (BM25-only)';
  const model = typeof e.model === 'string' && e.model.length > 0 ? e.model : '<unset>';
  return `${e.kind} · ${model} (${e.dim}-dim)`;
}

function pickContext(c: ContextStatusResult | null): StatusPayload['context'] {
  if (c?.ok !== true) return null;
  return {
    docCount: c.docCount,
    vecCount: c.vecCount,
    indexedFiles: c.indexedFiles,
    embedder: describeEmbedder(c.embedder),
    degraded: c.degraded === true,
  };
}

function pickWorkflow(w: WorkflowStatusResult | null): StatusPayload['workflow'] {
  // `workflow_status` returns `{ok:false,error:'no active task'}` (data) when no
  // task is active — normalize that to `null` so the payload's `workflow` field
  // cleanly means "active task snapshot present".
  if (w?.ok !== true) return null;
  return {
    taskId: w.taskId,
    phase: w.phase,
    state: w.state,
    mode: w.mode,
    nextGate: w.nextGate,
    degraded: w.degraded === true,
  };
}

function pickMemory(m: MemorySessionsResult | null): StatusPayload['memory'] {
  if (m?.ok !== true || !Array.isArray(m.sessions)) return null;
  let observations = 0;
  for (const s of m.sessions) observations += s.count;
  return { sessions: m.sessions.length, observations };
}

/**
 * Build the normalized payload from in-process project info + the daemon probe
 * + the (all-optional) count-tool results. Daemon `running`/`pid`/`uptimeSec`
 * come from the probe (the honest liveness source); `transport` is enriched from
 * `host_status` when that tool is reachable, else omitted. Every other section is
 * `null` when its engine is absent OR the daemon is down.
 */
function buildPayload(
  project: ProjectInfo,
  probe: DaemonProbe,
  host: HostStatusResult | null,
  store: StoreStatusResult | null,
  context: ContextStatusResult | null,
  workflow: WorkflowStatusResult | null,
  memory: MemorySessionsResult | null,
): StatusPayload {
  return {
    noir: NOIR_VERSION,
    project: { id: project.id, name: project.name },
    host: project.config.host,
    daemon: {
      running: probe.running,
      ...(probe.pid !== undefined ? { pid: probe.pid } : {}),
      ...(probe.uptimeSec !== undefined ? { uptimeSec: probe.uptimeSec } : {}),
      ...(host && typeof host.transport === 'string' ? { transport: host.transport } : {}),
    },
    store: pickStore(store),
    context: pickContext(context),
    workflow: pickWorkflow(workflow),
    memory: pickMemory(memory),
  };
}

// ---------------------------------------------------------------------------
// Human rendering (stderr). A two-column Field/Value table is the leanest
// readable shape for a status snapshot; cli-table3 is auto-stripped under
// NO_COLOR / non-TTY and the whole call is a no-op under --json.
// ---------------------------------------------------------------------------
export function formatDuration(sec?: number): string {
  if (typeof sec !== 'number' || sec < 0) return 'unknown';
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

export function describeDaemon(d: StatusPayload['daemon']): string {
  if (!d.running) return 'not running (start with `noir daemon start`)';
  const pid = typeof d.pid === 'number' ? `pid ${d.pid}` : 'pid unknown';
  const up = typeof d.uptimeSec === 'number' ? `, up ${formatDuration(d.uptimeSec)}` : '';
  const transport = typeof d.transport === 'string' ? `, ${d.transport}` : '';
  return `running (${pid}${up}${transport})`;
}

export function describeStore(s: StatusPayload['store']): string {
  if (!s) return 'unavailable (store engine not wired)';
  const flag = s.degraded ? `  ${badge('warn', 'degraded: read-only')}` : '';
  return `${s.docCount} docs / ${s.vecCount} vecs${flag}`;
}

export function describeContext(c: StatusPayload['context']): string {
  if (!c) return 'unavailable (context engine not wired)';
  const flag = c.degraded ? `  ${badge('warn', 'degraded')}` : '';
  return `${c.docCount} docs, ${c.vecCount} vecs, ${c.indexedFiles} files · embedder ${c.embedder}${flag}`;
}

export function describeWorkflow(w: StatusPayload['workflow']): string {
  if (!w) return 'no active task';
  const gate = w.nextGate ? ` → next gate: ${w.nextGate}` : '';
  const flag = w.degraded ? `  ${badge('warn', 'degraded')}` : '';
  return `${w.phase} (${w.state}, ${w.mode}) · task ${w.taskId}${gate}${flag}`;
}

export function describeMemory(m: StatusPayload['memory']): string {
  if (!m) return 'unavailable (memory engine not wired)';
  return `${m.observations} observations across ${m.sessions} session${m.sessions === 1 ? '' : 's'}`;
}

function renderHuman(p: StatusPayload, opts: CliOptions): void {
  // Banner + definition list both go to stderr (rendering is a no-op under
  // --json; we only render human when opts.json is false, but passing opts
  // keeps --quiet honest).
  log(`noir status — ${p.project.name} (${p.project.id})`, opts);
  definitionList(
    [
      { label: 'Project', value: `${p.project.name} (${p.project.id})` },
      { label: 'Host', value: p.host },
      { label: 'Noir', value: p.noir },
      { label: 'Daemon', value: describeDaemon(p.daemon) },
      { label: 'Store', value: describeStore(p.store) },
      { label: 'Context', value: describeContext(p.context) },
      { label: 'Workflow', value: describeWorkflow(p.workflow) },
      { label: 'Memory', value: describeMemory(p.memory) },
    ],
    opts,
  );
}

/**
 * Gather the live snapshot into the normalized {@link StatusPayload}. Extracted
 * so `noir handoff` reuses the SAME aggregation path as `noir status`
 * (single source for the multi-engine snapshot). Project info is read in-process
 * (uninitialized → exit 1 propagated to the caller); daemon state comes from a
 * {@link probeDaemon} (NEVER auto-starts). When the daemon is up, the optional
 * count tools are fetched over one {@link withRunningDaemon} connection; when it
 * is down, those sections are `null` and `daemon:{running:false}` — this function
 * never throws on a down daemon (the handoff command degrades gracefully).
 */
export async function gatherStatusPayload(opts: StatusOptions): Promise<StatusPayload> {
  // In-process project info — no daemon round-trip. Uninitialized → exit 1
  // (propagated; both `status` and `handoff` treat an uninitialized project as a
  // hard error — there is no project to snapshot).
  const project = loadProjectInfo(process.cwd());
  // Probe — never starts a daemon. A down daemon is reported honestly.
  const probe = await probeDaemon(opts);

  let host: HostStatusResult | null = null;
  let store: StoreStatusResult | null = null;
  let context: ContextStatusResult | null = null;
  let workflow: WorkflowStatusResult | null = null;
  let memory: MemorySessionsResult | null = null;

  if (probe.running) {
    // Reuse the already-running daemon — withRunningDaemon NEVER auto-starts
    // (probe-only). Pass the probe we already computed so it doesn't GET /health
    // a second time. Every tool is optional (tryTool folds a missing engine /
    // logical-failure envelope to null); host_status now only enriches
    // daemon.transport. If the daemon dies mid-snapshot (probe→connect race),
    // withRunningDaemon returns null and the sections stay null while the probe
    // data still populates the daemon section.
    await withRunningDaemon(
      opts,
      async (caller: DaemonToolCaller): Promise<void> => {
        host = await tryTool<HostStatusResult>(caller, 'host_status');
        store = await tryTool<StoreStatusResult>(caller, 'store_status');
        context = await tryTool<ContextStatusResult>(caller, 'context_status');
        workflow = await tryTool<WorkflowStatusResult>(caller, 'workflow_status');
        memory = await tryTool<MemorySessionsResult>(caller, 'memory_sessions');
      },
      probe,
    );
  }

  return buildPayload(project, probe, host, store, context, workflow, memory);
}

/**
 * `noir status`: aggregate the snapshot and render it.
 *
 * Project info is read in-process; daemon state comes from a {@link probeDaemon}
 * (NEVER auto-starts). When the daemon is up, the optional count tools are
 * fetched over one {@link withRunningDaemon} connection; when it is down, those
 * sections are `null` and `daemon:{running:false}` is rendered with exit 0
 * (status is informational — a down daemon is not an error).
 *
 * `--json` emits `{ok:true, data: StatusPayload}` to stdout. The human path
 * renders a two-column table on stderr. Uninitialized project → exit 1 from
 * `loadProjectInfo` (same as every other command).
 */
export async function status(opts: StatusOptions): Promise<void> {
  const payload = await gatherStatusPayload(opts);
  if (opts.json === true) {
    // Single stdout write — the versioned S9 F11 success envelope.
    process.stdout.write(`${JSON.stringify({ ok: true, data: payload })}\n`);
    return;
  }
  renderHuman(payload, opts);
}
