// Consolidation unit tests for @noir-ai/memory (slice S7, task t5).
//
// These exercise `runConsolidation` + its pure helpers DIRECTLY against an
// in-memory mock store + a fake model + a recording `indexDerived` callback —
// NO sqlite-vec native binary, NO embedder, NO network. They lock the
// provider-gated, append-only consolidation contract (DS-6) at the algorithm
// layer: the engine end-to-end path (real store + real embed) is covered by
// engine.test.ts.
//
// Privacy invariant (blueprint D6 / §9): the load-bearing assertion throughout
// is that `model.complete` is NEVER reached without an explicit, enabled
// provider — NEVER a silent paid call. Every refusal is logged to
// `memory:consolidation:miss` so it is never silent either.

import type { ProjectId, Store } from '@noir-ai/store';
import { describe, expect, it } from 'vitest';
import {
  CONSOLIDATION_SYSTEM_PROMPT,
  type ConsolidateOptions,
  type ConsolidationDeps,
  type ConsolidationResult,
  clearObservation,
  DEFAULT_CONSOLIDATE_LIMIT,
  DEFAULT_IMPORTANCE,
  dedupeConcepts,
  gatherCandidates,
  getConsolidationMisses,
  getObservation,
  getObservationIds,
  type MemoryCompleteResult,
  type MemoryConfig,
  type MemoryModel,
  type Observation,
  runConsolidation,
  serializeCandidates,
  setObservation,
  setObservationIds,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// In-memory store stand-in (KV tracked via a Map; doc/vec unused here)
// ---------------------------------------------------------------------------

function mockStore(): Store {
  const kv = new Map<string, unknown>();
  return {
    projectId: 'proj-test' as ProjectId,
    getState: <T>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
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

/** Build a minimal observation for seeding the KV + id index. */
function makeObs(id: string, over: Partial<Observation> = {}): Observation {
  const ts = over.ts ?? 1_000;
  return {
    id,
    type: 'fact',
    content: `content-${id}`,
    project: 'proj-test' as ProjectId,
    sessionId: over.sessionId ?? null,
    ts,
    lastAccessTs: ts,
    importance: over.importance ?? DEFAULT_IMPORTANCE,
    concepts: over.concepts ?? [],
    files: over.files ?? [],
    source: 'explicit',
    ...over,
  };
}

/** Seed observations into the authoritative KV rows + the id index (oldest-first). */
function seed(store: Store, obs: Observation[]): void {
  const ids = getObservationIds(store);
  for (const o of obs) {
    setObservation(store, o);
    if (!ids.includes(o.id)) ids.push(o.id);
  }
  setObservationIds(store, ids);
}

// ---------------------------------------------------------------------------
// Fake models
// ---------------------------------------------------------------------------

/** A fake model that records every call + returns a fixed lesson text. */
function fakeModel(text: string): MemoryModel & { calls: number; lastReq: unknown } {
  let calls = 0;
  let lastReq: unknown;
  return {
    async complete(req): Promise<MemoryCompleteResult> {
      calls += 1;
      lastReq = req;
      return { ok: true, text };
    },
    get calls(): number {
      return calls;
    },
    get lastReq(): unknown {
      return lastReq;
    },
  };
}

/** A model that returns `null` — first-class degradation (key/provider miss). */
function nullModel(): MemoryModel {
  return {
    async complete(): Promise<MemoryCompleteResult> {
      return null;
    },
  };
}

/** A model that returns `{ok:false}` — an attempted-call failure. */
function failModel(): MemoryModel {
  return {
    async complete(): Promise<MemoryCompleteResult> {
      return { ok: false, reason: 'upstream 503' };
    },
  };
}

/** A model that FAILS the test if reached — proves a gate held. */
function boobyTrappedModel(): MemoryModel {
  return {
    async complete(): Promise<MemoryCompleteResult> {
      throw new Error('model.complete must NOT be called past a held gate');
    },
  };
}

/** Builds deps with a recording `indexDerived` callback (no embedder needed). */
function deps(
  store: Store,
  over: Partial<ConsolidationDeps> & { model?: MemoryModel; config?: MemoryConfig } = {},
): { deps: ConsolidationDeps; written: Observation[] } {
  const written: Observation[] = [];
  const d: ConsolidationDeps = {
    store,
    model: over.model,
    config: over.config ?? {},
    projectId: (over.projectId ?? 'proj-test') as ProjectId,
    indexDerived: async (obs: Observation) => {
      written.push(obs);
    },
  };
  return { deps: d, written };
}

const ENABLED: MemoryConfig = {
  consolidation: { enabled: true, provider: 'anthropic', model: 'claude-haiku' },
};

// ===========================================================================
// runConsolidation — provider gate (the line between free and paid, DS-6)
// ===========================================================================

describe('runConsolidation — provider gate (DS-6)', () => {
  it('refuses no-provider when consolidation is disabled', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug', content: 'candidate' })]);
    const { deps: d } = deps(store, {
      model: boobyTrappedModel(),
      config: { consolidation: { enabled: false, provider: 'anthropic', model: 'x' } },
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('no-provider');
      expect(res.logged).toBe(true);
    }
  });

  it('refuses no-provider when enabled but no provider configured', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d } = deps(store, {
      model: boobyTrappedModel(),
      config: { consolidation: { enabled: true, model: 'x' } }, // provider MISSING
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-provider');
  });

  it('refuses no-provider when the whole consolidation block is absent', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d } = deps(store, { model: boobyTrappedModel(), config: {} });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-provider');
  });

  it('NEVER calls the model + logs the miss when the provider gate holds', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const model = boobyTrappedModel();
    const { deps: d } = deps(store, {
      model,
      config: { consolidation: { enabled: false } },
    });

    await runConsolidation(d);
    // The miss is recorded so the refusal is never silent (DS-6).
    const misses = getConsolidationMisses(store);
    expect(misses).toHaveLength(1);
    expect(misses[0]?.reason).toBe('no-provider');
    // provider is absent on the no-provider miss (none was configured).
    expect(misses[0]?.provider).toBeUndefined();
  });
});

// ===========================================================================
// runConsolidation — model gate (S8 wiring)
// ===========================================================================

describe('runConsolidation — model gate (S8 wiring)', () => {
  it('refuses model-unavailable when enabled+provider but no model injected', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d } = deps(store, {
      // model deliberately undefined (S8 not yet wired — the documented stub)
      config: ENABLED,
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('model-unavailable');
    const miss = getConsolidationMisses(store)[0];
    expect(miss?.reason).toBe('model-unavailable');
    expect(miss?.provider).toBe('anthropic'); // provider WAS configured
  });

  it('refuses model-unavailable when no explicit model id is configured', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d } = deps(store, {
      model: boobyTrappedModel(),
      config: { consolidation: { enabled: true, provider: 'anthropic' } }, // model MISSING
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('model-unavailable');
  });

  it('wraps complete()===null as model-unavailable (no lesson written)', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d, written } = deps(store, { model: nullModel(), config: ENABLED });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('model-unavailable');
    expect(written).toHaveLength(0); // nothing appended on a null model
  });

  it('wraps complete(){ok:false} as model-unavailable (no lesson written)', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' })]);
    const { deps: d, written } = deps(store, { model: failModel(), config: ENABLED });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('model-unavailable');
    expect(written).toHaveLength(0);
    expect(getConsolidationMisses(store)[0]?.reason).toBe('model-unavailable');
  });
});

// ===========================================================================
// runConsolidation — candidate gate
// ===========================================================================

describe('runConsolidation — candidate gate', () => {
  it('refuses no-candidates when the store is empty', async () => {
    const store = mockStore();
    const { deps: d } = deps(store, { model: boobyTrappedModel(), config: ENABLED });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-candidates');
  });

  it('refuses no-candidates + never calls the model when the type filter excludes all', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug', content: 'only a bug' })]);
    const model = boobyTrappedModel();
    const { deps: d } = deps(store, {
      model,
      config: {
        consolidation: { enabled: true, provider: 'anthropic', model: 'm', types: ['decision'] },
      },
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-candidates');
    expect(getConsolidationMisses(store)[0]?.reason).toBe('no-candidates');
  });

  it('refuses no-candidates when the model returns empty text', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug', content: 'candidate' })]);
    const { deps: d, written } = deps(store, {
      model: fakeModel('   '), // whitespace only → trims to empty
      config: ENABLED,
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-candidates');
    expect(written).toHaveLength(0); // empty synthesis ⇒ nothing appended
  });
});

// ===========================================================================
// runConsolidation — success (append-only, DS-6)
// ===========================================================================

describe('runConsolidation — success (append-only lesson)', () => {
  it('appends ONE type:lesson with provenance + canonical projectId', async () => {
    const store = mockStore();
    const a = makeObs('a', { type: 'bug', content: 'candidate A', concepts: ['x'] });
    const b = makeObs('b', { type: 'decision', content: 'candidate B', concepts: ['x', 'y'] });
    seed(store, [a, b]);
    const model = fakeModel('prefer local embeddings for offline consolidation');
    const { deps: d, written } = deps(store, {
      model,
      config: ENABLED,
      projectId: 'proj-canonical' as ProjectId,
    });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(model.calls).toBe(1); // single-shot (D5)
    expect(res.from).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(res.lessons).toHaveLength(1);

    const lesson = res.lessons[0];
    expect(lesson).toBeDefined();
    if (!lesson) return;
    expect(lesson.type).toBe('lesson');
    expect(lesson.content).toBe('prefer local embeddings for offline consolidation');
    expect(lesson.provenance).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(lesson.project).toBe('proj-canonical'); // NEVER a fs path (D6)
    expect(lesson.sessionId).toBeNull();
    expect(lesson.source).toBe('explicit');
    expect(lesson.importance).toBe(DEFAULT_IMPORTANCE);
    expect(lesson.files).toEqual([]);
    // concepts de-duplicated across the candidate set (first-seen order).
    expect(lesson.concepts).toEqual(['x', 'y']);

    // indexDerived was handed the SAME lesson object that is returned.
    expect(written).toHaveLength(1);
    expect(written[0]).toBe(lesson);
  });

  it('never mutates the source observations (append-only — originals untouched)', async () => {
    const store = mockStore();
    const a = makeObs('a', { type: 'bug', content: 'original A', concepts: ['k'] });
    seed(store, [a]);
    const before = { ...a };
    const { deps: d } = deps(store, { model: fakeModel('a derived lesson'), config: ENABLED });

    const res = await runConsolidation(d);
    expect(res.ok).toBe(true);

    // The original row in KV is byte-identical after consolidation (DS-6).
    const after = getObservation(store, 'a');
    expect(after).toEqual(before);
    // The original keeps its own type (NOT promoted to 'lesson').
    expect(after?.type).toBe('bug');
  });

  it('the model request carries the system prompt, tier=consolidate + provider/model', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug', content: 'cand' })]);
    const model = fakeModel('lesson');
    const { deps: d } = deps(store, { model, config: ENABLED });

    await runConsolidation(d);
    expect(model.lastReq).toMatchObject({
      system: CONSOLIDATION_SYSTEM_PROMPT,
      provider: 'anthropic',
      model: 'claude-haiku',
      tier: 'consolidate',
    });
  });

  it('opts.types overrides the configured type filter', async () => {
    const store = mockStore();
    seed(store, [
      makeObs('bug-1', { type: 'bug', content: 'a bug' }),
      makeObs('dec-1', { type: 'decision', content: 'a decision' }),
    ]);
    const model = fakeModel('lesson from decisions only');
    const { deps: d } = deps(store, {
      model,
      config: {
        // config says bugs only...
        consolidation: { enabled: true, provider: 'anthropic', model: 'm', types: ['bug'] },
      },
    });

    const res = await runConsolidation(d, { types: ['decision'] } satisfies ConsolidateOptions);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ...but opts.types overrides ⇒ only the decision is a source.
    expect(res.from).toEqual(['dec-1']);
  });

  it('opts.limit caps the candidate set (newest-first)', async () => {
    const store = mockStore();
    seed(store, [
      makeObs('o1', { type: 'fact', content: 'oldest', ts: 100 }),
      makeObs('o2', { type: 'fact', content: 'mid', ts: 200 }),
      makeObs('o3', { type: 'fact', content: 'newest', ts: 300 }),
    ]);
    const model = fakeModel('lesson');
    const { deps: d } = deps(store, { model, config: ENABLED });

    const res = await runConsolidation(d, { limit: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Newest-first ⇒ only o3 is a source when limit is 1.
    expect(res.from).toEqual(['o3']);
  });
});

// ===========================================================================
// gatherCandidates — deterministic selection (pure)
// ===========================================================================

describe('gatherCandidates (pure)', () => {
  it('returns newest-first, excludes lessons, respects types + limit', () => {
    const store = mockStore();
    seed(store, [
      makeObs('old', { type: 'bug', content: 'old', ts: 100 }),
      makeObs('lesson-1', { type: 'lesson', content: 'existing lesson', ts: 150 }),
      makeObs('mid', { type: 'decision', content: 'mid', ts: 200 }),
      makeObs('new', { type: 'bug', content: 'new', ts: 300 }),
    ]);

    // No filter: all non-lesson observations, newest-first.
    expect(gatherCandidates(store, undefined, 50).map((o) => o.id)).toEqual(['new', 'mid', 'old']);

    // Type filter to bugs only.
    expect(gatherCandidates(store, ['bug'], 50).map((o) => o.id)).toEqual(['new', 'old']);

    // Limit cap (newest-first).
    expect(gatherCandidates(store, undefined, 2).map((o) => o.id)).toEqual(['new', 'mid']);
  });

  it('skips ids whose KV row was forgotten (stale index entry)', () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug' }), makeObs('b', { type: 'bug' })]);
    // Simulate a forget that left a stale id in the index: clear 'a's
    // authoritative KV row (tombstone) but leave its id in `memory:index`.
    // gatherCandidates MUST tolerate the null row — never emit partial data.
    clearObservation(store, 'a');
    expect(gatherCandidates(store, undefined, 50).map((o) => o.id)).toEqual(['b']);
  });

  it('reports DEFAULT_CONSOLIDATE_LIMIT as 50', () => {
    expect(DEFAULT_CONSOLIDATE_LIMIT).toBe(50);
  });
});

// ===========================================================================
// serializeCandidates / dedupeConcepts (pure)
// ===========================================================================

describe('serializeCandidates (pure)', () => {
  it('emits a 1-indexed, type+ts-annotated block per candidate', () => {
    const out = serializeCandidates([
      makeObs('a', { type: 'bug', content: 'first', ts: 10 }),
      makeObs('b', { type: 'decision', content: 'second', ts: 20 }),
    ]);
    expect(out).toBe('[1] (type: bug, ts: 10) first\n\n[2] (type: decision, ts: 20) second');
  });
});

describe('dedupeConcepts (pure)', () => {
  it('collects unique concept tags across candidates (first-seen order)', () => {
    const out = dedupeConcepts([
      makeObs('a', { type: 'bug', concepts: ['x', 'y'] }),
      makeObs('b', { type: 'bug', concepts: ['y', 'z'] }),
    ]);
    expect(out).toEqual(['x', 'y', 'z']);
  });

  it('returns [] when no candidate carries concepts', () => {
    expect(dedupeConcepts([makeObs('a', { type: 'bug' })])).toEqual([]);
  });
});

// ===========================================================================
// ConsolidationResult shape (compile-time contract sanity)
// ===========================================================================

describe('ConsolidationResult variants', () => {
  it('the ok:true variant carries lessons + from', async () => {
    const store = mockStore();
    seed(store, [makeObs('a', { type: 'bug', content: 'c' })]);
    const { deps: d } = deps(store, { model: fakeModel('lesson'), config: ENABLED });
    const res: ConsolidationResult = await runConsolidation(d);
    if (res.ok) {
      expect(Array.isArray(res.lessons)).toBe(true);
      expect(Array.isArray(res.from)).toBe(true);
    } else {
      throw new Error('expected an ok result');
    }
  });
});
