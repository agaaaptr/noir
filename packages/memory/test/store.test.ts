// Store-layer unit tests for @noir-ai/memory (slice S7, task t2).
//
// These exercise ONLY the KV helpers in src/store.ts against an in-memory mock
// store — no sqlite-vec native binary, no FTS, no network. They lock the KV
// layout (`memory:obs:<id>`, `memory:sessions`, `memory:index`,
// `memory:consolidation:miss`) + the session rollup RMW semantics that engine.ts
// relies on. The end-to-end save/recall/forget flow against a real store lives
// in engine.test.ts (gated on sqlite-vec availability).

import type { ProjectId, Store } from '@noir-ai/store';
import { describe, expect, it } from 'vitest';
import {
  appendConsolidationMiss,
  bumpSession,
  CONSOLIDATION_MISS_KEY,
  clearObservation,
  decrementSession,
  getConsolidationMisses,
  getObservation,
  getObservationIds,
  getSessions,
  INDEX_KEY,
  OBS_PREFIX,
  obsKey,
  SESSIONS_KEY,
  setObservation,
  setObservationIds,
} from '../src/store.js';
import type { Observation, SessionInfo } from '../src/types.js';

// In-memory Store stand-in: only the KV surface is exercised here. The doc/vec
// methods are recorded (not real) so the engine tests can reuse the pattern.
function mockStore(): Store {
  const kv = new Map<string, unknown>();
  return {
    projectId: 'proj-mock' as ProjectId,
    getState: <T>(key: string): T | null => {
      // A tombstone (value === null) reads back as null, indistinguishable from
      // a missing key — this is the contract clearObservation relies on.
      return kv.has(key) ? (kv.get(key) as T) : null;
    },
    setState: <T>(key: string, value: T): void => {
      kv.set(key, value);
    },
    indexDoc: () => {},
    deleteDoc: () => {},
    searchFt: () => [],
    upsertVec: () => {},
    deleteVec: () => {},
    knn: () => [],
    countDocs: () => 0,
    countVecs: () => 0,
    exportMarkdown: async () => [],
    close: async () => {},
  } as Store;
}

function makeObs(id: string, over: Partial<Observation> = {}): Observation {
  const ts = over.ts ?? 1_000;
  return {
    id,
    type: 'pattern',
    content: `content-${id}`,
    project: 'proj-mock' as ProjectId,
    sessionId: over.sessionId ?? 'sess-1',
    ts,
    lastAccessTs: ts,
    importance: 0.5,
    concepts: [],
    files: [],
    source: 'explicit',
    ...over,
  };
}

describe('@noir-ai/memory store layer (KV helpers)', () => {
  describe('KV key layout', () => {
    it('obsKey prefixes with memory:obs:', () => {
      expect(obsKey('abc')).toBe('memory:obs:abc');
      expect(OBS_PREFIX).toBe('memory:obs:');
    });

    it('exposes the documented namespace constants', () => {
      expect(SESSIONS_KEY).toBe('memory:sessions');
      expect(INDEX_KEY).toBe('memory:index');
      expect(CONSOLIDATION_MISS_KEY).toBe('memory:consolidation:miss');
    });
  });

  describe('observation row (authoritative KV)', () => {
    it('round-trips the full row through set/get (DS-9 — content intact)', () => {
      const store = mockStore();
      const obs = makeObs('o1', { content: 'never truncated, full text' });
      expect(getObservation(store, 'o1')).toBeNull();
      setObservation(store, obs);
      expect(getObservation(store, 'o1')).toEqual(obs);
    });

    it('clearObservation tombstones the row so getObservation reads null', () => {
      const store = mockStore();
      const obs = makeObs('o1');
      setObservation(store, obs);
      expect(getObservation(store, 'o1')).not.toBeNull();
      clearObservation(store, 'o1');
      // Tombstone (null value) reads back as null — indistinguishable from
      // never-saved, which is exactly what forget needs.
      expect(getObservation(store, 'o1')).toBeNull();
    });
  });

  describe('id index (memory:index)', () => {
    it('returns [] when no index exists', () => {
      const store = mockStore();
      expect(getObservationIds(store)).toEqual([]);
    });

    it('round-trips an id list', () => {
      const store = mockStore();
      setObservationIds(store, ['a', 'b', 'c']);
      expect(getObservationIds(store)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('sessions rollup (bumpSession / decrementSession)', () => {
    it('bumpSession inserts a new session with count 1 + lastTs', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 100);
      const sessions = getSessions(store);
      expect(sessions).toEqual([{ id: 'sess-1', project: 'proj-mock', count: 1, lastTs: 100 }]);
    });

    it('bumpSession increments an existing session + bumps lastTs to the max', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 100);
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 50); // older ts
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 300);
      const sessions = getSessions(store);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.count).toBe(3);
      expect(sessions[0]?.lastTs).toBe(300); // max, not last
    });

    it('bumpSession tracks multiple sessions independently', () => {
      const store = mockStore();
      bumpSession(store, 'sess-a', 'proj-mock' as ProjectId, 10);
      bumpSession(store, 'sess-b', 'proj-mock' as ProjectId, 20);
      bumpSession(store, 'sess-a', 'proj-mock' as ProjectId, 30);
      const byId = new Map(getSessions(store).map((s) => [s.id, s] as const));
      expect(byId.get('sess-a')?.count).toBe(2);
      expect(byId.get('sess-a')?.lastTs).toBe(30);
      expect(byId.get('sess-b')?.count).toBe(1);
    });

    it('decrementSession drops the session when count reaches zero', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 100);
      decrementSession(store, 'sess-1');
      expect(getSessions(store)).toEqual([]);
    });

    it('decrementSession keeps the session (decremented) when count > 1', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 100);
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 200);
      decrementSession(store, 'sess-1');
      const sessions = getSessions(store);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.count).toBe(1);
      expect(sessions[0]?.lastTs).toBe(200); // lastTs unchanged on decrement
    });

    it('decrementSession is a no-op for an unknown session', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-mock' as ProjectId, 100);
      decrementSession(store, 'never-seen');
      const sessions = getSessions(store);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.count).toBe(1);
    });

    it('SessionInfo carries the canonical ProjectId (never a fs path, D6)', () => {
      const store = mockStore();
      bumpSession(store, 'sess-1', 'proj-canonical-id' as ProjectId, 1);
      const s: SessionInfo | undefined = getSessions(store).find((x) => x.id === 'sess-1');
      expect(s?.project).toBe('proj-canonical-id');
    });
  });

  describe('consolidation miss audit (memory:consolidation:miss)', () => {
    it('returns [] when no misses recorded', () => {
      expect(getConsolidationMisses(mockStore())).toEqual([]);
    });

    it('appendConsolidationMiss accumulates entries (refuse + LOG, DS-6)', () => {
      const store = mockStore();
      appendConsolidationMiss(store, { ts: 1, reason: 'no-provider' });
      appendConsolidationMiss(store, {
        ts: 2,
        reason: 'model-unavailable',
        provider: 'anthropic',
      });
      const misses = getConsolidationMisses(store);
      expect(misses).toEqual([
        { ts: 1, reason: 'no-provider' },
        { ts: 2, reason: 'model-unavailable', provider: 'anthropic' },
      ]);
    });
  });
});
