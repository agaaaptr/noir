// MemoryEngine for @noir-ai/memory (slice S7, task t2).
//
// The single object that ties the store layer + the shared S6 embedder + the
// optional S8 model layer together, and that the daemon injects as `ctx.memory`
// — the new optional ServerContext service, mirroring `ctx.store` /
// `ctx.engine` / `ctx.context`. It is constructed ONCE per serve lifecycle from
// the daemon's already-open Store handle (the single writer — blueprint D6:
// in-process, no sidecar, canonical ProjectId) + the SAME `EmbedFn` the daemon
// already resolved for S6 (the daemon owns one embedder; memory takes
// `{store, embed, ...}`, no embedder duplication — plan §Architecture).
//
// Public surface (the {@link MemoryEngine} contract in types.ts):
//   • save(input)     → indexDoc + upsertVec + KV(memory:obs:*) + sessions rollup
//   • recall(query)   → BM25 ∪ kNN fused by RRF (k=60) scoped to source:'memory',
//                       + cheap regex entity-boost, hydrated from KV (DS-5/DS-9).
//                       Implemented in recall.ts (t3); degrades to BM25-only when
//                       the embedder is unavailable (F8).
//   • search(query)   → store.searchFt BM25-only (the instant path, DS-7)
//   • sessions()      → KV(memory:sessions) rollup
//   • forget(ids)     → delete KV + best-effort doc/vec purge (A2)
//   • consolidate()   → explicit, provider-gated job (DS-6); appends type:'lesson'
//                       with provenance; originals never mutated
//   • status()        → snapshot mirroring ContextStatus / StoreStatus
//   • get(id)         → hydrate the full row from KV (engine-internal + tests)
//
// Single-writer discipline: the engine — like the context indexer — is the ONLY
// thing that writes `source:'memory'` rows through the injected handle; it
// never opens a second connection. Mutating ops are serialized:
//   • `save` and `consolidate` are ASYNC (they await the embedder / the model)
//     and run strictly one at a time over a promise chain (mirrors the context
//     indexer's `serialized`). Without it, two concurrent saves would each load
//     the same `memory:index` / `memory:sessions` snapshot, mutate their own
//     copy, and persist last-write-wins — orphaning the loser's row.
//   • `forget` is SYNCHRONOUS (the Store interface's deletes/sets are sync, and
//     the interface declares `forget(): ForgetResult` not a Promise). Its entire
//     read-modify-write runs in ONE synchronous block with no `await`, so it is
//     atomic w.r.t. the single-threaded event loop and cannot interleave with
//     itself; it therefore needs no chain. (A `save` suspended at `await embed`
//     and a `forget` called concurrently still commute: `save` re-reads the KV
//     inside its own post-await sync block, so it observes `forget`'s effects,
//     and `save` always mints a fresh unique id that cannot collide with a
//     forgotten one.)
//
// Blueprint D6 hard rules enforced here:
//   • in-process only — NO sidecar / external server;
//   • canonical ProjectId — NEVER a filesystem path;
//   • capture / store / retrieve ALWAYS local + free — no field here triggers a
//     network or LLM call;
//   • ANY LLM touch (consolidation) is OPT-IN + provider-explicit — `consolidate`
//     refuses + logs (`memory:consolidation:miss`) when no provider is
//     configured, and NEVER makes a paid call without one (the Agent-Memory
//     anti-pattern, §9);
//   • never truncate — `recall`/`search` hydrate the FULL `content` from the KV
//     row; the FTS snippet is only a preview window (DS-9).

import { randomUUID } from 'node:crypto';
import type { FtsHit, Store } from '@noir-ai/store';
import { runConsolidation } from './consolidate.js';
import { recallMemory } from './recall.js';
import {
  bumpSession,
  clearObservation,
  decrementSession,
  getObservation,
  getObservationIds,
  getSessions,
  setObservation,
  setObservationIds,
} from './store.js';
import {
  type ConsolidateOptions,
  type ConsolidationResult,
  DEFAULT_IMPORTANCE,
  type EmbedFn,
  type ForgetResult,
  type MemoryConfig,
  type MemoryEngine,
  type MemoryHit,
  type MemoryStatus,
  type Observation,
  type ProjectId,
  type RecallOptions,
  type SaveInput,
  type SearchOptions,
  type SessionInfo,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source bucket for every memory row (keeps context + memory disjoint, DS-2). */
const MEMORY_SOURCE = 'memory';

/** Default recall/search hit cap (mirrors Store.searchFt's default). */
const DEFAULT_SEARCH_LIMIT = 10;

/** Default observation type when {@link SaveInput.type} is omitted. */
const DEFAULT_TYPE: Observation['type'] = 'fact';

// ---------------------------------------------------------------------------
// S8 model injection (the ONLY LLM entry point — provider-gated, D5/DS-6)
// ---------------------------------------------------------------------------

/**
 * Per-call request shape passed to {@link MemoryModel.complete}. A structural
 * subset of S8's `CompleteRequest` (provider-EXPLICIT; no `tools`/`stream` —
 * single-shot only, blueprint D5). Defined locally so the memory package has no
 * value-level dependency on `@noir-ai/model`; the daemon seam (t6) binds
 * `complete(req, cfg)` into this shape, and tests inject a fake.
 */
export interface MemoryCompleteRequest {
  system?: string;
  prompt: string;
  /** Provider block name — explicit, NEVER env-inferred (D5/DS-6). */
  provider: string;
  /** Model id for this call. */
  model: string;
  maxTokens?: number;
  /** Bounded task tier (DS-9). Selects a per-tier output cap; never a provider. */
  tier?: 'draft' | 'title' | 'summarize' | 'consolidate';
}

/**
 * The subset of S8's `CompleteResult` that consolidation consumes. `null` is
 * first-class degradation (no provider resolvable at call time — the always-
 * available offline path, D5); `{ok:false}` is an attempted-call failure.
 */
export type MemoryCompleteResult =
  | { ok: true; text: string }
  | { ok: false; reason: string }
  | null;

/**
 * The optional S8 model injection. Its absence is the runtime signal that the
 * bounded model layer is not wired (consolidation then refuses
 * `'model-unavailable'` — the documented S7 stub, OQ-3/OQ-8). When present,
 * `complete` is the SOLE LLM entry point and is reached ONLY after the provider
 * gate passes (DS-6: never a silent paid call).
 */
export interface MemoryModel {
  complete(req: MemoryCompleteRequest): Promise<MemoryCompleteResult>;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/** Construction options for {@link MemoryEngineImpl} / {@link createMemoryEngine}. */
export interface MemoryEngineOptions {
  /** The daemon's store handle — the ONLY storage surface used (single writer). */
  store: Store;
  /**
   * Project root. Stored for API symmetry with {@link ContextEngine} and future
   * path normalization; v1 stores {@link Observation.files} repo-relative as-is.
   */
  root: string;
  /** Canonical project identifier (NEVER a filesystem path — blueprint D6). */
  projectId: ProjectId;
  /**
   * The shared S6 embedder (the daemon resolves it once and passes the SAME
   * `EmbedFn` to context + memory). A throw on `embed()` ⇒ the vec index is
   * skipped for that observation (F8-style degradation — the row is still
   * BM25-searchable via FTS5 + the authoritative KV row).
   */
  embed: EmbedFn;
  /** Optional S8 model injection for consolidation (absent ⇒ consolidation refuses). */
  model?: MemoryModel;
  /** Runtime memory config (the consolidation gate). Defaults to `{}` (offline). */
  config?: MemoryConfig;
  /** True when `store` was opened read-only (the daemon-down fallback). */
  storeDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Noir's cross-session memory engine — the `ctx.memory` service. Constructed
 * once per serve lifecycle (mirror `ContextEngine` / `WorkflowEngine`) from the
 * daemon's store handle + the shared S6 `EmbedFn` + an optional S8 model.
 * Implements the {@link MemoryEngine} contract; {@link get} is an extra public
 * method (beyond the interface) for recall hydration + tests.
 *
 * `consolidate` is ALWAYS present on the class and self-gates on the configured
 * provider; the daemon decides whether to register the `memory_consolidate` MCP
 * tool from `config.memory.consolidation.enabled` (OQ-5). Its refusal paths are
 * the documented stub behavior (spec §7) — never a crash, never a silent call.
 */
export class MemoryEngineImpl implements MemoryEngine {
  /** The daemon's single-writer store handle (possibly read-only). */
  readonly store: Store;
  /** Project root (stored for symmetry / future path normalization). */
  readonly root: string;
  /** Canonical project identifier (NEVER a filesystem path — D6). */
  readonly projectId: ProjectId;
  /**
   * Persistent degradation flag (read-only store). Mutating ops throw a clear
   * error upfront instead of letting the first write fail mid-run; reads
   * (recall/search/sessions/status) keep working.
   */
  readonly degraded: boolean;

  private readonly embed: EmbedFn;
  private readonly model: MemoryModel | undefined;
  private readonly config: MemoryConfig;

  // Single-flight serialization of ASYNC mutating ops (save / consolidate).
  // `forget` is sync + atomic (see file header) and bypasses this chain.
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: MemoryEngineOptions) {
    this.store = opts.store;
    this.root = opts.root;
    this.projectId = opts.projectId;
    this.embed = opts.embed;
    this.model = opts.model;
    this.config = opts.config ?? {};
    this.degraded = opts.storeDegraded === true;
  }

  // -------------------------------------------------------------------------
  // save
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.save */
  save(input: SaveInput): Promise<Observation> {
    return this.serialized(() => this.saveInternal(input));
  }

  private async saveInternal(input: SaveInput): Promise<Observation> {
    this.assertNotDegraded('save');
    const ts = Date.now();
    const observation: Observation = {
      id: randomUUID(),
      type: input.type ?? DEFAULT_TYPE,
      content: input.content,
      project: this.projectId,
      sessionId: input.sessionId ?? null,
      ts,
      lastAccessTs: ts,
      importance: input.importance ?? DEFAULT_IMPORTANCE,
      concepts: input.concepts ?? [],
      files: input.files ?? [],
      source: 'explicit',
    };
    // Embed BEFORE the synchronous KV block so the read-modify-write of
    // `memory:index` / `memory:sessions` runs without an `await` in between
    // (atomic w.r.t. the event loop — see file header).
    const vec = await this.embedBestEffort(observation.content);
    this.indexObservation(observation, vec);
    return observation;
  }

  /**
   * Write one observation to ALL three indexes in a single synchronous block:
   * FTS5 (`indexDoc`, content searchable) + sqlite-vec (`upsertVec`, best-effort
   * — skipped if the embedder or vec0 is unavailable, F8-style) + the
   * authoritative KV row (`memory:obs:<id>`) + the id index + the sessions
   * rollup. The `docs.meta` payload is the denormalized search projection
   * (Observation minus content); the KV row is the source of truth (R4).
   */
  private indexObservation(observation: Observation, vec: Float32Array | null): void {
    this.store.indexDoc({
      id: observation.id,
      source: MEMORY_SOURCE,
      content: observation.content,
      meta: obsMeta(observation),
    });
    if (vec !== null) {
      try {
        this.store.upsertVec(observation.id, vec, { source: MEMORY_SOURCE });
      } catch {
        // vec0 unavailable (native binary missing / read-only vec) — the row is
        // still BM25-searchable + hydrated from KV. Never crash a save on vec.
      }
    }
    setObservation(this.store, observation);
    // Append to the id index (idempotent on id — provenance lessons re-use save).
    const ids = getObservationIds(this.store);
    if (!ids.includes(observation.id)) {
      ids.push(observation.id);
      setObservationIds(this.store, ids);
    }
    if (observation.sessionId !== null) {
      bumpSession(this.store, observation.sessionId, observation.project, observation.ts);
    }
  }

  // -------------------------------------------------------------------------
  // get (extra public method — hydrate the FULL row from KV, DS-9)
  // -------------------------------------------------------------------------

  /**
   * Hydrate the full {@link Observation} for `id` from the authoritative KV row.
   * Returns `null` for an unknown / forgotten id. This is the only correct way
   * to read an observation's complete `content` (DS-9).
   */
  get(id: string): Observation | null {
    return getObservation(this.store, id);
  }

  // -------------------------------------------------------------------------
  // recall (t3: hybrid BM25 ∪ kNN + RRF + entity-boost — see recall.ts)
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.recall */
  async recall(query: string, opts?: RecallOptions): Promise<MemoryHit[]> {
    // Hybrid (t3): BM25 ∪ kNN fused by RRF (k=60, weights [0.5,0.5]) scoped to
    // source:'memory', + cheap regex entity-boost, hydrated to FULL content from
    // the authoritative KV row (DS-5/DS-9). Degrades to BM25-only when the
    // embedder is unavailable (F8) — `recallMemory` carries the `degraded` /
    // `mode` signal; the public {@link MemoryEngine.recall} contract returns the
    // hits. Read-only against the injected store; not serialized (concurrent
    // recalls are safe — they never mutate state).
    const { hits } = await recallMemory({ store: this.store, embed: this.embed }, query, opts);
    return hits;
  }

  // -------------------------------------------------------------------------
  // search (BM25-only instant path — final design, DS-7)
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.search */
  async search(query: string, opts?: SearchOptions): Promise<MemoryHit[]> {
    const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT;
    let ftsHits: FtsHit[] = [];
    try {
      ftsHits = this.store.searchFt(query, { source: MEMORY_SOURCE, limit });
    } catch {
      return [];
    }
    return this.hydrateHits(
      ftsHits.map((h) => ({ id: h.id, score: h.score })),
      undefined,
    );
  }

  /**
   * Hydrate a ranked id list into {@link MemoryHit}s from the authoritative KV
   * row, applying the optional `type` / `sessionId` filters. Each hit carries
   * the FULL `content` (DS-9). A ranked id with no KV row (a stale vec-only hit
   * whose row was forgotten) is dropped — never emitted with partial data.
   */
  private hydrateHits(
    scored: ReadonlyArray<{ id: string; score: number }>,
    opts: RecallOptions | undefined,
  ): MemoryHit[] {
    const out: MemoryHit[] = [];
    for (const row of scored) {
      const obs = getObservation(this.store, row.id);
      if (obs === null) continue;
      if (opts?.type !== undefined && obs.type !== opts.type) continue;
      if (opts?.sessionId !== undefined && obs.sessionId !== opts.sessionId) continue;
      out.push(toMemoryHit(obs, row.score));
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // sessions
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.sessions */
  sessions(): SessionInfo[] {
    return getSessions(this.store);
  }

  // -------------------------------------------------------------------------
  // forget (synchronous + atomic — see file header)
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.forget */
  forget(ids: string[]): ForgetResult {
    this.assertNotDegraded('forget');
    let deleted = 0;
    const idSet = new Set(ids);
    for (const id of ids) {
      const obs = getObservation(this.store, id);
      if (obs === null) continue;
      // Best-effort doc/vec purge (A2) + authoritative KV row clear. deleteDoc /
      // deleteVec are idempotent in the store, so a missing row is harmless.
      this.store.deleteDoc(id);
      try {
        this.store.deleteVec(id);
      } catch {
        // vec0 unavailable — the KV + FTS cleanup is the load-bearing part.
      }
      clearObservation(this.store, id);
      if (obs.sessionId !== null) {
        decrementSession(this.store, obs.sessionId);
      }
      deleted += 1;
    }
    // Drop the forgotten ids from the index (RMW, sync ⇒ atomic) so status()
    // and consolidate see a consistent count even if some ids were unknown.
    if (deleted > 0) {
      const remaining = getObservationIds(this.store).filter((i) => !idSet.has(i));
      setObservationIds(this.store, remaining);
    }
    return { deleted, ids };
  }

  // -------------------------------------------------------------------------
  // consolidate (explicit, provider-gated — DS-6)
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.consolidate */
  consolidate(opts?: ConsolidateOptions): Promise<ConsolidationResult> {
    return this.serialized(() => this.consolidateInternal(opts));
  }

  private async consolidateInternal(opts?: ConsolidateOptions): Promise<ConsolidationResult> {
    // Delegate to the standalone consolidation module (task t5). The engine
    // supplies the single-writer store handle, the optional S8 model injection,
    // the provider-explicit config, the canonical projectId, and an
    // `indexDerived` callback that embeds the lesson best-effort then writes it
    // through the SAME shared `indexObservation` path as a user `save` — so a
    // derived lesson lands identically (FTS5 + vec + KV + id index) and stays
    // searchable + hydratable. The gate logic (no-provider / model-unavailable /
    // no-candidates) + the append-only lesson construction live in consolidate.ts.
    return runConsolidation(
      {
        store: this.store,
        model: this.model,
        config: this.config,
        projectId: this.projectId,
        indexDerived: async (obs) => {
          const vec = await this.embedBestEffort(obs.content);
          this.indexObservation(obs, vec);
        },
      },
      opts,
    );
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  /** @inheritDoc MemoryEngine.status */
  status(): MemoryStatus {
    return {
      ok: true,
      projectId: this.store.projectId,
      observations: getObservationIds(this.store).length,
      degraded: this.degraded,
    };
  }

  // -------------------------------------------------------------------------
  // shared internals
  // -------------------------------------------------------------------------

  /**
   * Best-effort embedding: returns the vec, or `null` if the embedder is
   * unavailable (`kind:'none'`, native load failure, provider error). A `null`
   * vec skips `upsertVec` so the save still succeeds — the row is BM25-searchable
   * + hydrated from KV (F8-style degradation).
   */
  private async embedBestEffort(content: string): Promise<Float32Array | null> {
    try {
      return await this.embed(content);
    } catch {
      return null;
    }
  }

  /** Throw a clear, typed error when the store handle is read-only. */
  private assertNotDegraded(op: string): void {
    if (this.degraded) {
      throw new Error(`memory ${op} refused: store is read-only (daemon down)`);
    }
  }

  /**
   * Single-flight serialization of async mutating ops (mirrors the context
   * indexer's `serialized`). Forces `work` to run strictly after the previous
   * queued op completes. A failed op does NOT poison the queue — the chain
   * advances regardless, and the caller observes the real outcome via `result`.
   */
  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const result = this.chain.then(work);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

// ---------------------------------------------------------------------------
// Factory (the daemon seam / tests construct via this — mirrors buildContextEngine)
// ---------------------------------------------------------------------------

/**
 * Build a {@link MemoryEngineImpl} bound to a single store handle + the shared
 * S6 embedder + an optional S8 model. Constructed once per serve lifecycle
 * alongside the context + workflow engines. The daemon passes the SAME `embed`
 * it resolved for S6 (no embedder duplication) and resolves the model via S8's
 * `resolveModelConfig` only when `config.memory.consolidation.enabled` is set
 * (provider-explicit — never a silent paid call, D6).
 */
export function createMemoryEngine(opts: MemoryEngineOptions): MemoryEngineImpl {
  return new MemoryEngineImpl(opts);
}

// ---------------------------------------------------------------------------
// Small pure helpers (module-local)
// ---------------------------------------------------------------------------

/**
 * Build the denormalized `docs.meta` search payload (Observation minus `content`
 * + `id`). Written alongside the authoritative KV row; the KV row is the source
 * of truth for hydration (R4).
 */
function obsMeta(obs: Observation): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    type: obs.type,
    project: obs.project,
    sessionId: obs.sessionId,
    ts: obs.ts,
    lastAccessTs: obs.lastAccessTs,
    importance: obs.importance,
    concepts: obs.concepts,
    files: obs.files,
    source: obs.source,
  };
  if (obs.provenance !== undefined) meta.provenance = obs.provenance;
  return meta;
}

/** Project an {@link Observation} into a {@link MemoryHit} at a given score. */
function toMemoryHit(obs: Observation, score: number): MemoryHit {
  return {
    id: obs.id,
    type: obs.type,
    content: obs.content,
    score,
    concepts: obs.concepts,
    files: obs.files,
    ts: obs.ts,
    importance: obs.importance,
    source: obs.source,
  };
}
