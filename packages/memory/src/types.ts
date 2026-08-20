// @noir-ai/memory types.
//
// The observation data model + the MemoryEngine contract. These are the
// package's OWN interfaces — the storage surface (`Store`, `ProjectId`) is
// re-exported from @noir-ai/core / @noir-ai/store, and the embedder seam
// (`EmbedFn`, `EmbedderConfig`) is re-exported from @noir-ai/context (S6). The
// engine is built once per serve lifecycle from the daemon's already-open Store
// handle (the single writer) + the SAME `EmbedFn` the daemon already resolved
// for S6 — memory takes `{store, embed, ...}`, no embedder duplication.
//
// There is deliberately NO zod here: core owns the user-facing schema
// (`NoirConfigSchema.memory`) and memory owns this engine/type
// surface, which keeps the dependency graph acyclic (core never imports memory
// — mirrors @noir-ai/context types.ts).
//
// Blueprint D6 hard rules enforced by this model:
//   • canonical ProjectId (NEVER a filesystem path) — `Observation.project`;
//   • capture/store/retrieve always local + free — no field implies a network
//     or LLM call;
//   • ANY LLM touch (consolidation) is opt-in + provider-explicit — the ONLY
//     LLM entry point is the optional `MemoryEngine.consolidate`, gated on
//     `MemoryConfig.consolidation.provider`. It refuses + logs when
//     no provider is configured — NEVER a silent paid call;
//   • never truncate — `Observation.content` and `MemoryHit.content` carry the
//     FULL text; the FTS snippet is only a preview window.
//
// Conventions mirror @noir-ai/store / @noir-ai/context types: JSDoc on every
// interface/field, `as const` source tables → derived unions, `.js` extensions
// on relative ESM imports.

import type { ProjectId } from '@noir-ai/core';

// ---------------------------------------------------------------------------
// Taxonomy (dev-flavored OPEN enum; unknown values accepted + stored)
// ---------------------------------------------------------------------------

/**
 * Known observation types (dev-flavored). `lesson` is reserved for
 * consolidation output; the others are user-supplied on save. This
 * list is intentionally NOT a closed set: {@link MemoryType} also accepts any
 * unknown string so forward-compatible / user-defined types round-trip through
 * the store without a migration.
 */
export const MEMORY_TYPES = [
  'pattern',
  'preference',
  'architecture',
  'bug',
  'workflow',
  'fact',
  'decision',
  'lesson',
] as const;

/**
 * Open enum: one of {@link MEMORY_TYPES} OR any string. The `(string & {})`
 * intersection preserves literal autocompletion for the known values while
 * permitting arbitrary user-defined types (unknown values accepted +
 * stored). `lesson` is reserved for consolidation output.
 */
export type MemoryType = (typeof MEMORY_TYPES)[number] | (string & {});

/**
 * Provenance of a capture. `'explicit'` = a deliberate `memory_save` (the v1
 * default). `'auto:<hook>'` = an opt-in Claude Code hooks template
 * capture (e.g. `'auto:stop'`, `'auto:posttooluse'`); the template ships as
 * files the user installs deliberately — never auto-wired by `noir init`/`sync`.
 */
export type MemorySource = 'explicit' | `auto:${string}`;

// ---------------------------------------------------------------------------
// Defaults (applied at save time / on derived consolidation lessons)
// ---------------------------------------------------------------------------

/**
 * Default observation salience (spec §4.1). Applied by `MemoryEngine.save` when
 * {@link SaveInput.importance} is omitted, and by consolidation when appending a
 * derived `type:'lesson'` row. Shared via types.ts so save + consolidation agree
 * on the baseline without a cross-module value import.
 */
export const DEFAULT_IMPORTANCE = 0.5;

// ---------------------------------------------------------------------------
// Observation (the canonical row)
// ---------------------------------------------------------------------------

/**
 * The canonical memory row. Realized ON TOP of the store: the full row
 * lives in KV `memory:obs:<id>` (the authoritative source of truth — the line
 * between it and the indexes is the mitigation), with
 * `indexDoc({source:'memory'})` (FTS5) + `upsertVec({source:'memory'})`
 * (sqlite-vec) as search indexes. `content` is NEVER truncated — the
 * FTS snippet is only a preview window hydrated-around on recall.
 */
export interface Observation {
  /** Unique id (crypto.randomUUID()). Key into KV `memory:obs:<id>`. */
  id: string;
  /** Open enum. `lesson` is reserved for consolidation output. */
  type: MemoryType;
  /** Full text — never truncated. Indexed into FTS5 + embedded into vec0. */
  content: string;
  /** Canonical project id (NEVER a filesystem path — blueprint D6). */
  project: ProjectId;
  /** Host session id if known, else null. */
  sessionId: string | null;
  /** Created-at epoch millis. */
  ts: number;
  /** Bumped on recall hit (best-effort, single writer). */
  lastAccessTs: number;
  /** Salience 0..1 (default 0.5, applied at save time). */
  importance: number;
  /** User tags (no auto-LLM tagging in v1 — explicit only). */
  concepts: string[];
  /** Repo-relative paths mentioned. */
  files: string[];
  /** Capture provenance. */
  source: MemorySource;
  /**
   * Source observation ids, set ONLY on derived `type:'lesson'` rows produced
   * by consolidation. Absent on user-saved observations. Originals
   * are never mutated or deleted (append-only — reversible + auditable).
   */
  provenance?: string[];
}

// ---------------------------------------------------------------------------
// Save input (the `memory_save` payload)
// ---------------------------------------------------------------------------

/**
 * Input to {@link MemoryEngine.save} / the `memory_save` MCP tool. Only
 * `content` is required; the engine applies defaults (`type`, `importance`,
 * `source:'explicit'`, `ts`, `id`) at save time. No field here triggers a
 * network or LLM call — capture is always local + free.
 */
export interface SaveInput {
  /** Full text to remember. Required. */
  content: string;
  /** Open enum; a default is applied at save time when omitted. */
  type?: MemoryType;
  /** User tags. */
  concepts?: string[];
  /** Repo-relative paths mentioned. */
  files?: string[];
  /** Salience 0..1 (defaults to 0.5 at save time). */
  importance?: number;
  /** Host session id (recorded when known). */
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Recall / search hits (full content, never truncated)
// ---------------------------------------------------------------------------

/**
 * Options for {@link MemoryEngine.recall} (the hybrid path). Mirrors the S6
 * retriever's source-scoped search plus memory-side filters.
 */
export interface RecallOptions {
  /** Max results (default 10). */
  limit?: number;
  /** Filter to a single {@link MemoryType}. */
  type?: MemoryType;
  /** Filter to a single host session. */
  sessionId?: string;
}

/** Options for {@link MemoryEngine.search} (the BM25-only instant path). */
export interface SearchOptions {
  /** Max results (default 10). */
  limit?: number;
}

/**
 * A ranked recall/search hit. `content` is the FULL observation text hydrated
 * from the authoritative KV row — never the truncated FTS snippet.
 * `score` is the RRF-fused rank score (recall, k=60) or the BM25 score
 * (search); it is rank-based, not a normalized similarity.
 */
export interface MemoryHit {
  id: string;
  type: MemoryType;
  /** Full text — never truncated. */
  content: string;
  /** RRF-fused rank score (recall) or BM25 score (search). */
  score: number;
  concepts: string[];
  files: string[];
  /** Created-at epoch millis (from the observation). */
  ts: number;
  importance: number;
  source: MemorySource;
}

// ---------------------------------------------------------------------------
// Sessions rollup (KV `memory:sessions`)
// ---------------------------------------------------------------------------

/**
 * Per-session rollup, listed by {@link MemoryEngine.sessions}. Stored in KV
 * `memory:sessions` as a per-project list (solo user v1 — A3).
 */
export interface SessionInfo {
  /** Host session id. */
  id: string;
  /** Canonical project id (NEVER a filesystem path — D6). */
  project: ProjectId;
  /** Number of observations in this session. */
  count: number;
  /** Epoch millis of the most recent observation in this session. */
  lastTs: number;
}

// ---------------------------------------------------------------------------
// Config (the runtime consolidation gate)
// ---------------------------------------------------------------------------

/**
 * Consolidation config block. Provider-EXPLICIT (blueprint D5/D6): the
 * provider is NEVER inferred from env-var presence — no explicit `provider`
 * ⇒ {@link MemoryEngine.consolidate} refuses + logs
 * (`{ok:false, reason:'no-provider'}`) and writes a `memory:consolidation:miss`
 * KV audit entry. NEVER a silent paid call.
 */
export interface ConsolidationConfig {
  /** Master switch (default false). When false, `consolidate` is unregistered. */
  enabled?: boolean;
  /** Provider key, e.g. 'anthropic' | 'openai' | 'ollama'. Required to run. */
  provider?: string;
  /** Provider-specific model id. */
  model?: string;
  /** Restrict candidates to these types (default: every non-`lesson` type). */
  types?: string[];
}

/**
 * Runtime memory config consumed by the engine (the subset of the core
 * `memory:` block that affects engine behavior). The full user-facing schema
 * (capture / hooksTemplate / recall / consolidation) lives in
 * `NoirConfigSchema.memory` (@noir-ai/core); this is its runtime
 * projection. Defaults to `{}` ⇒ consolidation disabled (offline, free).
 */
export interface MemoryConfig {
  consolidation?: ConsolidationConfig;
}

// ---------------------------------------------------------------------------
// Op results
// ---------------------------------------------------------------------------

/**
 * Result of {@link MemoryEngine.forget}: the KV row removed + best-effort
 * doc/vec purge (deleteDoc + deleteVec — A2's acceptable v1 behavior).
 */
export interface ForgetResult {
  /** Number of observations actually removed. */
  deleted: number;
  /** Ids passed to forget (echoed for the MCP envelope). */
  ids: string[];
}

/** Options for {@link MemoryEngine.consolidate}. */
export interface ConsolidateOptions {
  /** Restrict candidates to these types (overrides config). */
  types?: string[];
  /** Cap on candidate observations. */
  limit?: number;
}

/**
 * Result of {@link MemoryEngine.consolidate}. Either a success appending
 * one or more derived `type:'lesson'` rows (originals never mutated), or a
 * documented refusal. A refusal is NEVER a crash and NEVER a silent paid call:
 * `logged:true` records the miss so the user can see why nothing happened.
 */
export type ConsolidationResult =
  | { ok: true; lessons: Observation[]; from: string[] }
  | {
      ok: false;
      /** Why consolidation did not run. */
      reason: 'no-provider' | 'model-unavailable' | 'no-candidates';
      /** True once the miss has been written to the KV audit log. */
      logged: boolean;
    };

/**
 * Snapshot returned by {@link MemoryEngine.status} (mirrors `ContextStatus` /
 * `StoreStatus`). `observations` is a live read off the single writer handle.
 */
export interface MemoryStatus {
  ok: boolean;
  /** Canonical project id (never a filesystem path — D6). */
  projectId: string;
  /** Number of observations (rows indexed with `source:'memory'`). */
  observations: number;
  /** True when the store handle is read-only (saves/forgets will refuse). */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Engine contract (the `ctx.memory` service)
// ---------------------------------------------------------------------------

/**
 * The memory engine — the `ctx.memory` service (the contract the daemon seam
 * in task t4 types against, and tests mock). Constructed once per serve
 * lifecycle from the daemon's store handle + the shared S6 `EmbedFn` (mirrors
 * `ContextEngine` / `WorkflowEngine`). The daemon owns the single embedder and
 * passes the SAME `EmbedFn` to both the context and memory engines — no
 * embedder duplication (plan §Architecture).
 *
 * `consolidate` is OPTIONAL: registered only when consolidation is enabled AND
 * a provider is configured (OQ-5). Its absence is the static signal
 * that no LLM surface is wired (D5).
 *
 * Single-writer discipline: the engine — like the context indexer — is the
 * ONLY thing that writes `source:'memory'` rows through the injected handle; it
 * never opens a second store connection (blueprint D6: in-process only, no
 * sidecar).
 */
export interface MemoryEngine {
  /** Persist an observation (FTS5 + vec0 + KV `memory:obs:<id>`); returns the row. */
  save(input: SaveInput): Promise<Observation>;
  /**
   * Hybrid recall: BM25 ∪ kNN fused by RRF (k=60), scoped to `source:'memory'`,
   * + cheap regex entity-boost, hydrated from KV. Degrades to
   * BM25-only when the embedder is unavailable.
   */
  recall(query: string, opts?: RecallOptions): Promise<MemoryHit[]>;
  /**
   * Hybrid recall WITH the per-call outcome signal. The wire (daemon
   * `memory_recall`, CLI in-process fallback) uses this so a BM25-only
   * degradation is honestly reported instead of always surfacing degraded:false.
   */
  recallWithMeta(
    query: string,
    opts?: RecallOptions,
  ): Promise<{ hits: MemoryHit[]; degraded: boolean; mode: 'hybrid' | 'bm25-only' }>;
  /** Instant BM25-only lookup scoped to `source:'memory'` (no embed cost). */
  search(query: string, opts?: SearchOptions): Promise<MemoryHit[]>;
  /** Per-session rollups from KV `memory:sessions`. */
  sessions(): SessionInfo[];
  /** Remove observations: KV row + best-effort doc/vec purge. */
  forget(ids: string[]): ForgetResult;
  /**
   * Explicit consolidation job. Provider-gated: refuses + logs if no
   * provider is configured — NEVER a silent paid call. Appends derived
   * `type:'lesson'` rows; originals are never mutated.
   */
  consolidate?(opts?: ConsolidateOptions): Promise<ConsolidationResult>;
  /** State snapshot (mirrors `ContextStatus` / `StoreStatus`). */
  status(): MemoryStatus;
}

// ---------------------------------------------------------------------------
// Re-exports (single import surface — mirrors @noir-ai/context types.ts)
// ---------------------------------------------------------------------------

// The embedder seam reuses: recall embeds the query via the SAME `EmbedFn`
// the daemon already resolved for S6. Re-exported from @noir-ai/context so the
// memory package has a single import surface for both the seam + its config.
export type { EmbedderConfig, EmbedFn } from '@noir-ai/context';
// Canonical project identifier (NEVER a filesystem path — blueprint D6).
// Re-exported so memory modules import it from `../types.js` rather than
// reaching into @noir-ai/core directly.
export type { ProjectId } from '@noir-ai/core';
