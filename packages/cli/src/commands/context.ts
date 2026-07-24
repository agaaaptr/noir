// S9 t5 — `noir context {search,index,status}`.
//
// Thin MCP-client commands over the running daemon's S6 context engine. Every
// read/write here is a single `callDaemonTool` round-trip; the daemon is the
// sole writer (blueprint §2), so the CLI never opens the store in-process. If
// the daemon can't be reached, `callDaemonTool` maps the failure onto exit 4
// (DAEMON_DOWN) with the stable remediation hint — see daemon-client.ts.
//
// A daemon tool's OWN logical-failure envelope (`{ok:false, degraded:true,
// error}` — e.g. a read-only store refusing `context_index`, or the embedder
// throwing inside `context_search`) is DATA, not a transport failure: it parses
// cleanly, so this module surfaces it honestly as exit 1 (ERROR) with the
// daemon's message, rather than re-packaging it as daemon-down.
//
// Stream discipline (S9 DS-4): `--json` emits the versioned `{ok:true,data}`
// envelope to STDOUT (the only stdout write); human tables / snippets go to
// STDERR via the centralized `table()` / `log()` helpers (auto-stripped under
// NO_COLOR / non-TTY / --json). `--limit` is coerced here; an invalid value is a
// USAGE error (exit 2) before we touch the daemon.

import { callDaemonTool, type DaemonClientOptions } from '../daemon-client.js';
import { type CliOptions, EXIT, fail, info, log, table } from '../output.js';

/** Options accepted by every `context` sub-command (globals + daemon knobs). */
export interface ContextOptions extends CliOptions, DaemonClientOptions {}

// ---------------------------------------------------------------------------
// Tool result shapes (the relevant slices of the daemon's wire payloads). The
// daemon returns these as JSON text; daemon-client parses to `unknown`, so each
// reader treats a foreign field as undefined and the command degrades to a clear
// error rather than crashing. Local types = the CLI depends only on the MCP
// wire contract (mirrors status.ts).
// ---------------------------------------------------------------------------

/** Normalized search hit rendered to humans + emitted in the JSON payload. */
export interface ContextHit {
  path: string;
  score: number;
  snippet: string;
  source: string;
}

/** `context_search` success payload (SearchResult + the echoed query). */
export interface ContextSearchData {
  query: string;
  hits: ContextHit[];
  consumedTokens: number;
  truncated: boolean;
  degraded: boolean;
  mode: string;
}

/** `context_index` success payload (IndexResult). */
export interface ContextIndexData {
  indexed: number;
  skipped: number;
  deleted: number;
  failed: number;
  totalChunks: number;
  degraded: boolean;
}

/** `context_status` payload (ContextStatus). `ok` is a literal so the success /
 * failure union narrows cleanly against {@link ToolFailure} (ok:false). */
export interface ContextStatusData {
  ok: true;
  projectId: string;
  docCount: number;
  vecCount: number;
  indexedFiles: number;
  embedder: { kind: string; model?: string; dim: number };
  degraded: boolean;
}

/** A daemon logical-failure envelope (`{ok:false,…}`) — read generically. */
interface ToolFailure {
  ok: false;
  degraded?: boolean;
  error?: string;
  reason?: string;
}

/** The raw `context_search` wire payload (success branch). */
interface ContextSearchResult {
  ok: true;
  results?: unknown;
  consumedTokens?: number;
  truncated?: boolean;
  degraded?: boolean;
  mode?: string;
}

/** The raw `context_index` wire payload (success branch). */
interface ContextIndexResult {
  ok: true;
  indexed?: number;
  skipped?: number;
  deleted?: number;
  failed?: number;
  totalChunks?: number;
  degraded?: boolean;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a commander `--limit <n>` string into a positive int, or fail with
 * exit 2 (USAGE) naming the flag — mirrors the daemon's zod
 * `number().int().positive()` but at the CLI edge so a bad value never starts a
 * daemon round-trip.
 */
function parseLimit(raw: string | undefined, label: string, opts: CliOptions): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    fail(EXIT.USAGE, `${label}: --limit must be a positive integer (got '${raw}')`, opts);
  }
  return n;
}

/**
 * Normalize a daemon logical-failure envelope into a thrown exit-1 ERROR. The
 * envelope is data (it parsed cleanly), so this is NOT daemon-down; we surface
 * the daemon's own `error`/`reason` verbatim so the user sees the real cause
 * (e.g. "store is read-only (daemon down) — context_index is unavailable").
 */
function failTool(label: string, envelope: ToolFailure, opts: CliOptions): never {
  const detail = envelope.error ?? envelope.reason ?? 'unknown failure';
  fail(EXIT.ERROR, `${label}: ${detail}`, opts);
}

/** Narrow a raw wire hit (RetrieverHit) into the rendered {@link ContextHit}. */
function toHit(raw: unknown): ContextHit {
  const h = (raw ?? {}) as Record<string, unknown>;
  return {
    path: typeof h['path'] === 'string' ? h['path'] : '<unknown>',
    score: typeof h['score'] === 'number' ? h['score'] : 0,
    snippet: typeof h['snippet'] === 'string' ? h['snippet'] : '',
    source: typeof h['source'] === 'string' ? h['source'] : '',
  };
}

// ---------------------------------------------------------------------------
// `noir context search <query> [--limit N]`
// ---------------------------------------------------------------------------
export interface ContextSearchOptions extends ContextOptions {
  query: string;
  /** Raw `--limit` string from commander; parsed + validated here. */
  limit?: string;
}

export async function contextSearch(opts: ContextSearchOptions): Promise<void> {
  const limit = parseLimit(opts.limit, 'context search', opts);
  const res = await callDaemonTool<ContextSearchResult | ToolFailure>(opts, 'context_search', {
    query: opts.query,
    ...(limit === undefined ? {} : { limit }),
  });
  if (res.ok !== true) failTool('context search', res, opts);

  const data: ContextSearchData = {
    query: opts.query,
    hits: Array.isArray(res.results) ? (res.results as unknown[]).map(toHit) : [],
    consumedTokens: typeof res.consumedTokens === 'number' ? res.consumedTokens : 0,
    truncated: res.truncated === true,
    degraded: res.degraded === true,
    mode: typeof res.mode === 'string' ? res.mode : 'unknown',
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  renderSearch(data, opts);
}

function renderSearch(data: ContextSearchData, opts: CliOptions): void {
  const flag = data.degraded ? ' [degraded: BM25-only]' : '';
  const trunc = data.truncated ? ' (budget hit — results truncated)' : '';
  log(
    `context search — ${data.hits.length} hit${data.hits.length === 1 ? '' : 's'} · ${data.mode} · ${data.consumedTokens} tokens${flag}${trunc}`,
    opts,
  );
  table(
    data.hits.map((h, i) => ({
      '#': i + 1,
      Path: h.path,
      Score: h.score.toFixed(4),
      Snippet: h.snippet,
    })),
    ['#', 'Path', 'Score', 'Snippet'],
    opts,
  );
}

// ---------------------------------------------------------------------------
// `noir context index [--path ...] [--force]`
// ---------------------------------------------------------------------------
export interface ContextIndexOptions extends ContextOptions {
  /** Raw repeated `--path` values from commander (`undefined` ⇒ index root). */
  paths?: string[];
  /** Recognized for future content-hash-bypass; not yet honored by the daemon. */
  force?: boolean;
}

export async function contextIndex(opts: ContextIndexOptions): Promise<void> {
  // `--force` is part of the S9 §7 signature, but the daemon's context_index
  // tool does not accept a force flag yet (content-hash incremental is always
  // on). Rather than silently ignore it, surface the gap honestly so a user
  // scripting `--force` learns it's a no-op rather than assuming a full reindex.
  if (opts.force === true) {
    info(
      'context index: --force is recognized but not yet honored (content-hash is always incremental).',
      opts,
    );
  }
  const args: Record<string, unknown> =
    opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {};
  const res = await callDaemonTool<ContextIndexResult | ToolFailure>(opts, 'context_index', args);
  if (res.ok !== true) failTool('context index', res, opts);

  const data: ContextIndexData = {
    indexed: typeof res.indexed === 'number' ? res.indexed : 0,
    skipped: typeof res.skipped === 'number' ? res.skipped : 0,
    deleted: typeof res.deleted === 'number' ? res.deleted : 0,
    failed: typeof res.failed === 'number' ? res.failed : 0,
    totalChunks: typeof res.totalChunks === 'number' ? res.totalChunks : 0,
    degraded: res.degraded === true,
  };

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  renderIndex(data, opts.paths, opts);
}

function renderIndex(data: ContextIndexData, paths: string[] | undefined, opts: CliOptions): void {
  const scope = paths && paths.length > 0 ? paths.join(', ') : '.';
  const flag = data.degraded ? ' [degraded: vectors skipped]' : '';
  log(`context index — ${scope}${flag}`, opts);
  table(
    [
      { Field: 'Indexed (new)', Value: data.indexed },
      { Field: 'Skipped (unchanged)', Value: data.skipped },
      { Field: 'Deleted (removed)', Value: data.deleted },
      { Field: 'Failed', Value: data.failed },
      { Field: 'Total chunks', Value: data.totalChunks },
    ],
    ['Field', 'Value'],
    opts,
  );
  if (data.failed > 0) {
    info(`${data.failed} file(s) could not be indexed (binary / IO / encoding).`, opts);
  }
}

// ---------------------------------------------------------------------------
// `noir context status`
// ---------------------------------------------------------------------------
export async function contextStatus(opts: ContextOptions): Promise<void> {
  const res = await callDaemonTool<ContextStatusData | ToolFailure>(opts, 'context_status');
  if (res.ok !== true) failTool('context status', res, opts);
  // `context_status` already carries its own `ok:true`; reuse it as the payload.
  const data = res;

  if (opts.json === true) {
    process.stdout.write(`${JSON.stringify({ ok: true, data })}\n`);
    return;
  }
  renderStatus(data, opts);
}

function describeEmbedder(e: ContextStatusData['embedder']): string {
  if (!e || e.kind === 'none') return 'none (BM25-only)';
  const model = typeof e.model === 'string' && e.model.length > 0 ? e.model : '<unset>';
  return `${e.kind} · ${model} (${e.dim}-dim)`;
}

function renderStatus(data: ContextStatusData, opts: CliOptions): void {
  const flag = data.degraded ? ' [degraded]' : '';
  log(`context status — ${data.projectId}${flag}`, opts);
  table(
    [
      { Field: 'Project', Value: data.projectId },
      { Field: 'Docs', Value: data.docCount },
      { Field: 'Vectors', Value: data.vecCount },
      { Field: 'Indexed files', Value: data.indexedFiles },
      { Field: 'Embedder', Value: describeEmbedder(data.embedder) },
      { Field: 'Degraded', Value: data.degraded ? 'yes' : 'no' },
    ],
    ['Field', 'Value'],
    opts,
  );
}
