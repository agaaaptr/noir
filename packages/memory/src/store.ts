// Memory store layer for @noir-ai/memory (slice S7, task t2).
//
// A thin KV + index facade over the existing @noir-ai/store. Observations are
// realized ON TOP of the store (DS-2 — NO schema migration): the authoritative
// full row lives in KV `memory:obs:<id>`, with `indexDoc({source:'memory'})`
// (FTS5) + `upsertVec({source:'memory'})` (sqlite-vec) as search indexes. This
// module owns ONLY the KV layout + single-key accessors (+ the two
// read-modify-write helpers `bumpSession` / `decrementSession`); the
// read-modify-write orchestration across keys + single-flight serialization
// lives in engine.ts.
//
// KV layout (namespaced `memory:` — disjoint from `ctx:` / `workflow:*`):
//   memory:obs:<id>            → Observation        (authoritative full row, DS-9)
//   memory:sessions            → SessionInfo[]      (per-project rollup, A3)
//   memory:index               → string[]           (all obs ids; status count +
//                                                    consolidate candidate source)
//   memory:consolidation:miss  → ConsolidationMiss[] (refusal audit log, DS-6)
//
// Authoritative-source discipline (R4 mitigation): the KV row
// `memory:obs:<id>` is the source of truth; `docs.meta` is a denormalized
// search payload written alongside it. Recall hydrates the FULL `Observation`
// from KV (never the truncated FTS snippet — DS-9). `forget` clears the KV row
// (tombstone, mirroring the context indexer) AND purges the doc/vec indexes
// best-effort (A2's acceptable v1 behavior).
//
// These helpers use ONLY the Store interface (no second connection, no schema
// change — blueprint D6: in-process only, canonical ProjectId). The RMW
// helpers (`bumpSession`, `decrementSession`, `appendConsolidationMiss`) MUST
// be called from within the engine's single-flight / synchronous KV block so
// two concurrent writers cannot clobber the list — see engine.ts.

import type { Store } from '@noir-ai/store';
import type { Observation, SessionInfo } from './types.js';

// ---------------------------------------------------------------------------
// KV keys (namespaced `memory:`)
// ---------------------------------------------------------------------------

/** Per-observation authoritative-row key prefix; value is the full {@link Observation}. */
export const OBS_PREFIX = 'memory:obs:';
/** KV key holding the per-project {@link SessionInfo} rollup list. */
export const SESSIONS_KEY = 'memory:sessions';
/** KV key holding the sorted list of all observation ids (status + candidates). */
export const INDEX_KEY = 'memory:index';
/** KV key holding the consolidation refusal audit log (DS-6: refuse + LOG). */
export const CONSOLIDATION_MISS_KEY = 'memory:consolidation:miss';

/** Build a `memory:obs:<id>` KV key. */
export function obsKey(id: string): string {
  return `${OBS_PREFIX}${id}`;
}

// ---------------------------------------------------------------------------
// Authoritative observation row (KV `memory:obs:<id>`)
// ---------------------------------------------------------------------------

/**
 * Hydrate the FULL {@link Observation} for `id` from the authoritative KV row.
 * Returns `null` when the id was never saved (or has been forgotten — the
 * tombstone reads back as `null`). This is the ONLY correct way to read an
 * observation's complete `content` (DS-9: never the truncated FTS snippet).
 */
export function getObservation(store: Store, id: string): Observation | null {
  return store.getState<Observation>(obsKey(id));
}

/** Write the authoritative full row (the source of truth — DS-2/R4). */
export function setObservation(store: Store, obs: Observation): void {
  store.setState(obsKey(obs.id), obs);
}

/**
 * Clear the authoritative KV row for `id` (tombstone — mirrors the context
 * indexer's `persist(..., tombstones)` which writes `null`). The id MUST also
 * be dropped from {@link INDEX_KEY} and the session rollup by the caller so the
 * index stays consistent (see engine.ts `forget`).
 */
export function clearObservation(store: Store, id: string): void {
  store.setState(obsKey(id), null);
}

// ---------------------------------------------------------------------------
// Observation id index (KV `memory:index`) — status count + consolidate source
// ---------------------------------------------------------------------------

/** All observation ids currently tracked (insertion order). Empty array if none. */
export function getObservationIds(store: Store): string[] {
  return store.getState<string[]>(INDEX_KEY) ?? [];
}

/** Overwrite the full id list (used by `save`/`forget` after an atomic RMW). */
export function setObservationIds(store: Store, ids: string[]): void {
  store.setState(INDEX_KEY, ids);
}

// ---------------------------------------------------------------------------
// Sessions rollup (KV `memory:sessions`)
// ---------------------------------------------------------------------------

/** The per-project {@link SessionInfo} rollup list (empty array if none). */
export function getSessions(store: Store): SessionInfo[] {
  return store.getState<SessionInfo[]>(SESSIONS_KEY) ?? [];
}

/** Overwrite the sessions rollup (used by the RMW helpers below). */
export function setSessions(store: Store, sessions: SessionInfo[]): void {
  store.setState(SESSIONS_KEY, sessions);
}

/**
 * Increment the rollup for `sessionId` (inserting a new entry when first seen),
 * bumping `lastTs` to the max. RMW — call within the engine's serialized/sync KV
 * block so two concurrent saves cannot lose an increment.
 */
export function bumpSession(
  store: Store,
  sessionId: string,
  project: SessionInfo['project'],
  ts: number,
): void {
  const sessions = getSessions(store);
  const existing = sessions.find((s) => s.id === sessionId);
  if (existing) {
    existing.count += 1;
    if (ts > existing.lastTs) existing.lastTs = ts;
  } else {
    sessions.push({ id: sessionId, project, count: 1, lastTs: ts });
  }
  setSessions(store, sessions);
}

/**
 * Decrement the rollup for `sessionId`, dropping the entry when it reaches zero
 * so a forgotten observation cleans up its own empty session. RMW — call within
 * the engine's serialized/sync KV block. No-op for an unknown session.
 */
export function decrementSession(store: Store, sessionId: string): void {
  const sessions = getSessions(store);
  const existing = sessions.find((s) => s.id === sessionId);
  if (existing === undefined) return;
  existing.count -= 1;
  if (existing.count <= 0) {
    setSessions(
      store,
      sessions.filter((s) => s.id !== sessionId),
    );
  } else {
    setSessions(store, sessions);
  }
}

// ---------------------------------------------------------------------------
// Consolidation refusal audit (KV `memory:consolidation:miss`) — DS-6
// ---------------------------------------------------------------------------

/**
 * One recorded consolidation refusal. `reason` is the documented
 * {@link ConsolidationResult} refusal cause; `provider` is recorded when a
 * provider WAS configured but the run still refused (e.g. the S8 layer was
 * unavailable), so the user can see exactly why nothing happened.
 */
export interface ConsolidationMiss {
  /** Epoch millis of the refusal. */
  ts: number;
  /** Documented refusal reason (`'no-provider' | 'model-unavailable' | 'no-candidates'`). */
  reason: string;
  /** Provider key, when one was configured (absent for the no-provider case). */
  provider?: string;
}

/** The full refusal audit log (newest appended last). Empty array if none. */
export function getConsolidationMisses(store: Store): ConsolidationMiss[] {
  return store.getState<ConsolidationMiss[]>(CONSOLIDATION_MISS_KEY) ?? [];
}

/**
 * Append a refusal record to the audit log. RMW — called ONLY from the engine's
 * serialized `consolidate`, so the append cannot race itself. DS-6: a refusal is
 * never silent — the miss is recorded so the user can see why no lesson was
 * written (and that NO paid call was made).
 */
export function appendConsolidationMiss(store: Store, miss: ConsolidationMiss): void {
  const misses = getConsolidationMisses(store);
  misses.push(miss);
  store.setState(CONSOLIDATION_MISS_KEY, misses);
}
