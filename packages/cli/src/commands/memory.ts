// S9 — `noir memory {recall,save,sessions,forget,consolidate}`.
//
// Thin MCP-client commands over the running daemon's memory engine. Each is
// a `callDaemonTool` round-trip (or `withDaemon` when capability discovery is
// needed); the daemon owns the sole store handle, so the CLI never opens it
// in-process. Daemon-unreachable ⇒ exit 4 (DAEMON_DOWN) from daemon-client.
//
// Scriptability (S9 hard rule): `memory save --content` may be supplied by
// flag; only when it's missing AND the session is interactive do we prompt via
// @clack (lazy-imported so non-interactive paths never load it). Missing
// content under non-interactive / --no-input / --json / CI / NO_COLOR ⇒ exit 2
// (USAGE) naming the missing flag — NO blocking prompt on a pipe. A cancel at
// the prompt ⇒ exit 5 (CANCELLED).
//
// `memory consolidate` is opt-in + provider-explicit (blueprint D5/D6): the
// daemon registers the `memory_consolidate` tool ONLY when the user set
// `memory.consolidation.enabled: true` AND a provider+model resolved. Calling a
// tool the daemon doesn't register would mis-map onto exit 4 (daemon-down), so
// we discover the daemon's tool list first (caller.listTools) and, if the tool
// is absent, emit a clear "not exposed" message + exit 1 (honest — the daemon IS
// up, consolidation just isn't enabled). A provider refusal
// (`{ok:false,reason:'no-provider'|'model-unavailable'|'no-candidates'}`) is
// honored as exit 1 with the reason; it is NEVER a silent paid call.

import { callDaemonTool, type DaemonClientOptions, withDaemon } from '../daemon-client.js';
import {
  type CliOptions,
  definitionList,
  EXIT,
  fail,
  info,
  isInteractive,
  log,
  table,
} from '../output.js';
import { badge } from '../theme.js';

/** Options accepted by every `memory` sub-command (globals + daemon knobs). */
export interface MemoryOptions extends CliOptions, DaemonClientOptions {}

// ---------------------------------------------------------------------------
// Tool result shapes (slices of the daemon wire payloads; CLI depends only on
// the MCP contract — local types, mirrors context.ts / status.ts).
// ---------------------------------------------------------------------------

/** A daemon logical-failure envelope, read generically. */
interface ToolFailure {
  ok: false;
  degraded?: boolean;
  error?: string;
  reason?: string;
  logged?: boolean;
}

/** Normalized memory hit (MemoryHit) rendered to humans + JSON. */
export interface MemoryHitData {
  id: string;
  type: string;
  score: number;
  content: string;
  concepts: string[];
  files: string[];
  ts: number;
  importance: number;
  source: string;
}

/** `memory_recall` success payload. */
interface MemoryRecallResult {
  ok: true;
  results?: unknown;
  degraded?: boolean;
}

/** `memory_save` success payload. */
interface MemorySaveResult {
  ok: true;
  id?: string;
  observation?: Record<string, unknown>;
}

/** One row of `memory_sessions`. */
export interface SessionRow {
  id: string;
  count: number;
  lastTs: number;
}

/** `memory_sessions` success payload. */
interface MemorySessionsResult {
  ok: true;
  sessions?: unknown;
}

/** `memory_forget` success payload (ForgetResult). */
interface MemoryForgetResult {
  ok: true;
  deleted?: number;
  ids?: unknown;
}

/** `memory_consolidate` success payload (ConsolidationResult success branch). */
interface MemoryConsolidateOk {
  ok: true;
  lessons?: unknown;
  from?: unknown;
}

/** `memory_consolidate` refusal (ConsolidationResult failure branch — data). */
interface MemoryConsolidateRefusal {
  ok: false;
  reason: 'no-provider' | 'model-unavailable' | 'no-candidates';
  logged?: boolean;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Coerce `--limit` (commander string) to a positive int, else exit 2. */
function parseLimit(raw: string | undefined, label: string, opts: CliOptions): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(EXIT.USAGE, `${label}: --limit must be a positive integer (got '${raw}')`, opts);
  }
  return n;
}

/** Split a comma-separated flag value (`--files a,b,c`) into a trimmed list. */
function splitCsv(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const out = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

/** Narrow a raw memory hit (MemoryHit) into the rendered {@link MemoryHitData}. */
function toHit(raw: unknown): MemoryHitData {
  const h = (raw ?? {}) as Record<string, unknown>;
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? (v.filter((x) => typeof x === 'string') as string[]) : [];
  return {
    id: typeof h.id === 'string' ? h.id : '',
    type: typeof h.type === 'string' ? h.type : '',
    score: typeof h.score === 'number' ? h.score : 0,
    content: typeof h.content === 'string' ? h.content : '',
    concepts: arr(h.concepts),
    files: arr(h.files),
    ts: typeof h.ts === 'number' ? h.ts : 0,
    importance: typeof h.importance === 'number' ? h.importance : 0,
    source: typeof h.source === 'string' ? h.source : '',
  };
}

/** Surface a daemon logical-failure envelope as exit 1 (daemon was reachable). */
function failTool(label: string, envelope: ToolFailure, opts: CliOptions): never {
  const detail = envelope.error ?? envelope.reason ?? 'unknown failure';
  fail(EXIT.ERROR, `${label}: ${detail}`, opts);
}

/** Render an epoch-ms as a short ISO-ish stamp for human tables. */
function stamp(ts: number): string {
  if (typeof ts !== 'number' || ts <= 0) return '-';
  // UTC ISO (no tz surprises); clipped for table density.
  return new Date(ts).toISOString().replace('T', ' ').replace(/\..*$/, 'Z');
}

// ---------------------------------------------------------------------------
// `noir memory recall <query> [--limit N]`
// ---------------------------------------------------------------------------
export interface MemoryRecallOptions extends MemoryOptions {
  query: string;
  limit?: string;
}

export async function memoryRecall(opts: MemoryRecallOptions): Promise<void> {
  const limit = parseLimit(opts.limit, 'memory recall', opts);
  const res = await callDaemonTool<MemoryRecallResult | ToolFailure>(opts, 'memory_recall', {
    query: opts.query,
    ...(limit === undefined ? {} : { limit }),
  });
  if (res.ok !== true) failTool('memory recall', res, opts);

  const hits = Array.isArray(res.results) ? (res.results as unknown[]).map(toHit) : [];
  const data = { query: opts.query, hits, degraded: res.degraded === true };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  renderRecall(data.query, hits, data.degraded, opts);
}

function renderRecall(
  query: string,
  hits: MemoryHitData[],
  degraded: boolean,
  opts: CliOptions,
): void {
  const flag = degraded ? `  ${badge('warn', 'degraded: BM25-only')}` : '';
  log(
    `memory recall — ${hits.length} hit${hits.length === 1 ? '' : 's'} for '${query}'${flag}`,
    opts,
  );
  if (hits.length === 0) {
    info('(no memories matched)', opts);
    return;
  }
  // Full content per hit (never truncate the DATA; display shows it whole
  // in a readable block rather than a cramped table cell). The block-list shape
  // is load-bearing — do NOT sweep this into the responsive table().
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i];
    if (h === undefined) continue;
    const head = `[${i + 1}] ${h.type} · score ${h.score.toFixed(4)} · importance ${h.importance.toFixed(2)} · ${h.id}`;
    log(head, opts);
    if (h.files.length > 0) log(`    files: ${h.files.join(', ')}`, opts);
    if (h.concepts.length > 0) log(`    tags: ${h.concepts.join(', ')}`, opts);
    log(`    ${h.content}`, opts);
  }
}

// ---------------------------------------------------------------------------
// `noir memory save [--content] [--type] [--files]`
// ---------------------------------------------------------------------------
export interface MemorySaveOptions extends MemoryOptions {
  content?: string;
  type?: string;
  files?: string;
}

export async function memorySave(opts: MemorySaveOptions): Promise<void> {
  const content = await resolveContent(opts);
  const files = splitCsv(opts.files);
  const args: Record<string, unknown> = { content };
  if (typeof opts.type === 'string' && opts.type.length > 0) args.type = opts.type;
  if (files !== undefined) args.files = files;

  const res = await callDaemonTool<MemorySaveResult | ToolFailure>(opts, 'memory_save', args);
  if (res.ok !== true) failTool('memory save', res, opts);

  const id = typeof res.id === 'string' ? res.id : '';
  const observation = res.observation ?? {};
  const data = { id, observation };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(`Saved memory ${id}.`, opts);
  renderObservation(observation, opts);
}

/**
 * Resolve `--content`: from the flag when given; otherwise prompt interactively
 * (only when the session is interactive); otherwise exit 2 naming the flag. The
 * @clack import is lazy so a scripted / CI / --json run never loads it, and a
 * cancel at the prompt maps to exit 5.
 */
async function resolveContent(opts: MemorySaveOptions): Promise<string> {
  if (typeof opts.content === 'string' && opts.content.length > 0) return opts.content;
  if (!isInteractive(opts)) {
    fail(
      EXIT.USAGE,
      'memory save requires --content <text> (or re-run in an interactive terminal to be prompted)',
      opts,
    );
  }
  const clack = await import('@clack/prompts');
  const value = await clack.text({
    message: 'Memory to save:',
    placeholder: 'the insight / decision / pattern to remember',
    validate: (v: string) => (v.trim().length === 0 ? 'content cannot be empty' : undefined),
  });
  if (clack.isCancel(value)) {
    clack.cancel('Cancelled.');
    fail(EXIT.CANCELLED, 'cancelled', opts);
  }
  return String(value);
}

function renderObservation(obs: Record<string, unknown>, opts: CliOptions): void {
  const rows: Array<{ label: string; value: unknown }> = [];
  for (const key of ['id', 'type', 'importance', 'ts', 'source', 'project', 'sessionId']) {
    if (obs[key] !== undefined) rows.push({ label: key, value: obs[key] });
  }
  if (rows.length > 0) definitionList(rows, opts);
  const content = obs.content;
  if (typeof content === 'string') log(`\n${content}`, opts);
}

// ---------------------------------------------------------------------------
// `noir memory sessions`
// ---------------------------------------------------------------------------
export async function memorySessions(opts: MemoryOptions): Promise<void> {
  const res = await callDaemonTool<MemorySessionsResult | ToolFailure>(opts, 'memory_sessions');
  if (res.ok !== true) failTool('memory sessions', res, opts);

  const sessions: SessionRow[] = Array.isArray(res.sessions)
    ? (res.sessions as unknown[]).map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        return {
          id: typeof s.id === 'string' ? s.id : '',
          count: typeof s.count === 'number' ? s.count : 0,
          lastTs: typeof s.lastTs === 'number' ? s.lastTs : 0,
        };
      })
    : [];
  const data = { sessions };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(`memory sessions — ${sessions.length} session${sessions.length === 1 ? '' : 's'}`, opts);
  table(
    sessions.map((s) => ({ Session: s.id, Observations: s.count, 'Last seen': stamp(s.lastTs) })),
    ['Session', 'Observations', 'Last seen'],
    opts,
  );
}

// ---------------------------------------------------------------------------
// `noir memory forget <id> [<id> ...]`
// ---------------------------------------------------------------------------
export interface MemoryForgetOptions extends MemoryOptions {
  /** Positional observation ids. */
  ids: string[];
}

export async function memoryForget(opts: MemoryForgetOptions): Promise<void> {
  if (opts.ids.length === 0) {
    fail(EXIT.USAGE, 'memory forget requires at least one <id>', opts);
  }
  const res = await callDaemonTool<MemoryForgetResult | ToolFailure>(opts, 'memory_forget', {
    ids: opts.ids,
  });
  if (res.ok !== true) failTool('memory forget', res, opts);

  const deleted = typeof res.deleted === 'number' ? res.deleted : 0;
  const data = { deleted, ids: opts.ids };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  log(`Forgot ${deleted} observation${deleted === 1 ? '' : 's'}.`, opts);
}

// ---------------------------------------------------------------------------
// `noir memory consolidate [--types <csv>] [--limit N]`
// ---------------------------------------------------------------------------
export interface MemoryConsolidateOptions extends MemoryOptions {
  /** Comma-separated type filter (mapped to the daemon's `types[]`). */
  types?: string;
  limit?: string;
}

export async function memoryConsolidate(opts: MemoryConsolidateOptions): Promise<void> {
  // Capability discovery (spec: "only if the daemon exposes it — else a clear
  // message"): a daemon that didn't opt into consolidation registers no
  // `memory_consolidate` tool. Detecting that via listTools lets us say so
  // honestly instead of calling a missing tool (which would mis-map to exit 4).
  const exposed = await withDaemon(opts, async (caller) => caller.listTools());
  if (!exposed.includes('memory_consolidate')) {
    fail(
      EXIT.ERROR,
      'memory consolidate: the daemon does not expose the memory_consolidate tool. Enable it in .noir/config under memory.consolidation (enabled: true + a provider + model), then restart the daemon.',
      opts,
    );
  }

  const types = splitCsv(opts.types);
  const limit = parseLimit(opts.limit, 'memory consolidate', opts);
  const args: Record<string, unknown> = {};
  if (types !== undefined) args.types = types;
  if (limit !== undefined) args.limit = limit;

  const res = await callDaemonTool<MemoryConsolidateOk | MemoryConsolidateRefusal | ToolFailure>(
    opts,
    'memory_consolidate',
    args,
  );
  if (res.ok === true) {
    const lessons = Array.isArray(res.lessons) ? (res.lessons as unknown[]) : [];
    const from = Array.isArray(res.from) ? (res.from as unknown[]) : [];
    const data = { lessons, from };
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
      return;
    }
    log(
      `Consolidated ${lessons.length} lesson${lessons.length === 1 ? '' : 's'} from ${from.length} observation${from.length === 1 ? '' : 's'}.`,
      opts,
    );
    for (let i = 0; i < lessons.length; i++) {
      const l = lessons[i];
      if (l === undefined) continue;
      const obs = (l ?? {}) as Record<string, unknown>;
      const id = typeof obs.id === 'string' ? obs.id : `<lesson ${i + 1}>`;
      const content = typeof obs.content === 'string' ? obs.content : '';
      log(`- ${id}: ${content}`, opts);
    }
    return;
  }

  // Refusal (no-provider / model-unavailable / no-candidates) or a degraded
  // envelope. Both are honest exit-1 outcomes — consolidation did NOT run. Read
  // via a record cast so the picks are valid across the refusal + ToolFailure
  // union members (they don't all carry `error` / `degraded`).
  const env = res as unknown as Record<string, unknown>;
  const reason =
    (typeof env.reason === 'string' ? env.reason : undefined) ??
    (typeof env.error === 'string' ? env.error : undefined) ??
    'unknown';
  const logged = env.logged === true || env.degraded === true;
  const suffix = logged ? ' (logged)' : '';
  fail(EXIT.ERROR, `memory consolidate did not run: ${reason}${suffix}`, opts);
}
