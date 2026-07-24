// Engine integration tests for @noir-ai/memory (slice S7, task t2).
//
// Two layers:
//   1. describeStore (gated on sqlite-vec): a REAL store exercises the full
//      save → recall/search → forget → sessions → consolidate flow against FTS5
//      + KV, including the source:'memory' scoping invariant and the
//      provider-gated consolidation (refuses + logs when no provider — never a
//      silent paid call; appends a lesson with provenance when a fake model is
//      injected).
//   2. describe (no gate, in-memory mock store): the degraded (read-only)
//      throw path + single-flight serialization of concurrent saves — pure logic
//      that does not need FTS.
//
// Everything is offline: `fakeEmbedFn` (384-dim deterministic) + a fake model.
// No network, no real LLM.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeEmbedFn } from '@noir-ai/context';
import { createProjectId } from '@noir-ai/core';
import { openStore, type ProjectId, type Store, vecAvailability } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryEngine,
  getConsolidationMisses,
  getObservationIds,
  type MemoryCompleteResult,
  type MemoryModel,
} from '../src/index.js';

// CI gate: opening a store loads sqlite-vec (per-platform native binary). Probe
// once; if absent, skip the store-backed describes with a labelled reason
// (mirrors context/test/retriever.test.ts — full suite stays green offline).
const VEC_PROBE = vecAvailability();
const describeStore = VEC_PROBE.ok ? describe : describe.skip;
const storeLabel = VEC_PROBE.ok
  ? 'memory engine (real store)'
  : `memory engine (real store) [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

let root: string;
let projectId: ProjectId;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-engine-'));
  projectId = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A deterministic 384-dim embed (context's fakeEmbedFn is offline + dim-stable).
const embed = fakeEmbedFn();

/**
 * A fake S8 model that returns a fixed lesson text; tracks call count. The
 * `calls` getter is defined directly on the returned literal (NOT via
 * Object.assign, which would snapshot the getter's value once).
 */
function fakeModel(text: string): MemoryModel & { calls: number } {
  let calls = 0;
  return {
    async complete(): Promise<MemoryCompleteResult> {
      calls += 1;
      return { ok: true, text };
    },
    get calls(): number {
      return calls;
    },
  };
}

/**
 * A model that FAILS the test if reached (proves the provider gate holds), AND
 * tracks `calls` so the gate can also be asserted as `model.calls === 0`
 * (DS-6: never a silent paid call on no-provider / no-candidates). Mirrors
 * {@link fakeModel}'s closure-counter + getter shape so both fakes are
 * interchangeable in tests that read `.calls`.
 */
function boobyTrappedModel(): MemoryModel & { calls: number } {
  let calls = 0;
  return {
    async complete(): Promise<MemoryCompleteResult> {
      calls += 1;
      throw new Error('model.complete must NOT be called without a provider');
    },
    get calls(): number {
      return calls;
    },
  };
}

describeStore(storeLabel, () => {
  it('save persists the full observation; get hydrates it verbatim (DS-9)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });

    const obs = await engine.save({
      content: 'always resolve the embedder once per serve lifecycle',
      type: 'pattern',
      concepts: ['embedder', 'lifecycle'],
      files: ['packages/context/src/contextEngine.ts'],
      importance: 0.8,
      sessionId: 'sess-1',
    });

    expect(obs.id).toBeTruthy();
    expect(obs.type).toBe('pattern');
    expect(obs.source).toBe('explicit');
    expect(obs.project).toBe(projectId);
    // full content round-trips verbatim through the authoritative KV row.
    const hydrated = engine.get(obs.id);
    expect(hydrated?.content).toBe(obs.content);
    expect(hydrated?.concepts).toEqual(['embedder', 'lifecycle']);
  });

  it('save applies defaults (type=fact, importance=0.5, source=explicit)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    const obs = await engine.save({ content: 'minimal' });
    expect(obs.type).toBe('fact');
    expect(obs.importance).toBe(0.5);
    expect(obs.source).toBe('explicit');
    expect(obs.sessionId).toBeNull();
    expect(obs.concepts).toEqual([]);
  });

  it('recall returns the full content via BM25 (t2 fallback path)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({
      content: 'the embedder should be resolved once per serve lifecycle',
      type: 'pattern',
      sessionId: 'sess-1',
    });
    const hits = await engine.recall('embedder lifecycle');
    expect(hits.length).toBeGreaterThan(0);
    // DS-9: full content, never the truncated FTS snippet.
    expect(hits[0]?.content).toContain('resolved once per serve lifecycle');
  });

  it('recall is scoped to source:memory (does not leak context docs)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    // A non-memory doc (context bucket) that WOULD match the query.
    store.indexDoc({
      id: 'ctx-1',
      source: 'codebase',
      content: 'the embedder lifecycle lives here',
      meta: {},
    });
    await engine.save({
      content: 'remember the memory embedder note',
      sessionId: 's',
    });
    const hits = await engine.recall('embedder');
    // recall MUST work (sanity) AND stay scoped to memory (no context leak).
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.id !== 'ctx-1')).toBe(true);
  });

  it('recall filters by type and sessionId', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({
      content: 'bug note about embedder crash',
      type: 'bug',
      sessionId: 'a',
    });
    await engine.save({
      content: 'pattern note about embedder use',
      type: 'pattern',
      sessionId: 'b',
    });

    const bugs = await engine.recall('embedder', { type: 'bug' });
    expect(bugs.length).toBeGreaterThan(0);
    expect(bugs.every((h) => h.type === 'bug')).toBe(true);

    const inB = await engine.recall('embedder', { sessionId: 'b' });
    expect(inB.length).toBeGreaterThan(0);
    expect(inB.every((h) => h.content.includes('pattern'))).toBe(true);
  });

  it('search is the BM25-only instant path and returns full content', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({ content: 'instant search note about sqlite', sessionId: 's' });
    const hits = await engine.search('sqlite');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain('instant search note');
  });

  it('status reports the live observation count + canonical projectId', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    expect(engine.status().observations).toBe(0);
    await engine.save({ content: 'one', sessionId: 's' });
    await engine.save({ content: 'two', sessionId: 's' });
    const st = engine.status();
    expect(st.observations).toBe(2);
    expect(st.projectId).toBe(projectId);
    expect(st.degraded).toBe(false);
  });

  it('sessions rolls up count + lastTs per session', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({ content: 'a', sessionId: 'sess-1' });
    await engine.save({ content: 'b', sessionId: 'sess-1' });
    await engine.save({ content: 'c', sessionId: 'sess-2' });
    const byId = new Map(engine.sessions().map((s) => [s.id, s] as const));
    expect(byId.get('sess-1')?.count).toBe(2);
    expect(byId.get('sess-2')?.count).toBe(1);
    const s1 = byId.get('sess-1');
    const s2 = byId.get('sess-2');
    if (s1 && s2) {
      expect(s1.lastTs).toBeGreaterThanOrEqual(s2.lastTs - 1000);
    }
  });

  it('forget removes the row + decrements the session + purges doc/vec', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    const obs = await engine.save({
      content: 'forget me embedder',
      sessionId: 'sess-1',
    });
    expect(engine.get(obs.id)).not.toBeNull();

    const result = engine.forget([obs.id]);
    expect(result.deleted).toBe(1);
    expect(result.ids).toEqual([obs.id]);

    // KV authoritative row cleared.
    expect(engine.get(obs.id)).toBeNull();
    // status reflects the removal.
    expect(engine.status().observations).toBe(0);
    // session decremented away.
    expect(engine.sessions().find((s) => s.id === 'sess-1')).toBeUndefined();
    // subsequent recall no longer returns it.
    const hits = await engine.recall('embedder');
    expect(hits.every((h) => h.id !== obs.id)).toBe(true);
  });

  it('forget reports deleted=0 for unknown ids (idempotent)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    const result = engine.forget(['never-existed']);
    expect(result.deleted).toBe(0);
  });

  it('consolidate REFUSES (no-provider) + logs, and never calls the model', async () => {
    const store = await openStore({ projectId, root });
    const model = boobyTrappedModel();
    const engine = createMemoryEngine({
      store,
      root,
      projectId,
      embed,
      model,
      config: { consolidation: { enabled: false } }, // disabled ⇒ no-provider
    });
    await engine.save({ content: 'a candidate', type: 'bug' });

    const res = await engine.consolidate();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('no-provider');
      expect(res.logged).toBe(true);
    }
    expect(model.calls).toBe(0); // never a silent paid call (DS-6)
    const misses = getConsolidationMisses(store);
    expect(misses).toHaveLength(1);
    expect(misses[0]?.reason).toBe('no-provider');
  });

  it('consolidate refuses model-unavailable when enabled+provider but no model injected', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({
      store,
      root,
      projectId,
      embed,
      // no model injected (S8 not yet wired)
      config: {
        consolidation: { enabled: true, provider: 'anthropic', model: 'claude-3-5' },
      },
    });
    await engine.save({ content: 'a candidate', type: 'bug' });

    const res = await engine.consolidate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('model-unavailable');
    expect(getConsolidationMisses(store)[0]?.reason).toBe('model-unavailable');
  });

  it('consolidate appends a lesson with provenance when a fake model is injected', async () => {
    const store = await openStore({ projectId, root });
    const model = fakeModel('prefer local embeddings for offline memory consolidation');
    const engine = createMemoryEngine({
      store,
      root,
      projectId,
      embed,
      model,
      config: {
        consolidation: { enabled: true, provider: 'anthropic', model: 'claude-3-5' },
      },
    });
    const a = await engine.save({
      content: 'candidate A about embeddings',
      type: 'bug',
    });
    const b = await engine.save({
      content: 'candidate B about offline runs',
      type: 'decision',
    });
    const before = engine.status().observations;

    const res = await engine.consolidate();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(model.calls).toBe(1);
    expect(res.from).toEqual(expect.arrayContaining([a.id, b.id]));
    const lesson = res.lessons[0];
    expect(lesson).toBeDefined();
    if (!lesson) return;
    expect(lesson.type).toBe('lesson');
    expect(lesson.provenance).toEqual(expect.arrayContaining([a.id, b.id]));
    expect(lesson.content).toContain('local embeddings');

    // Append-only: originals untouched + the new lesson is indexed.
    expect(engine.get(a.id)).not.toBeNull();
    expect(engine.get(b.id)).not.toBeNull();
    expect(engine.status().observations).toBe(before + 1);
    expect(getObservationIds(store)).toContain(lesson.id);
  });

  it('consolidate reports no-candidates when nothing matches the type filter', async () => {
    const store = await openStore({ projectId, root });
    const model = boobyTrappedModel();
    const engine = createMemoryEngine({
      store,
      root,
      projectId,
      embed,
      model,
      config: {
        consolidation: {
          enabled: true,
          provider: 'anthropic',
          model: 'claude-3-5',
          types: ['decision'],
        },
      },
    });
    await engine.save({ content: 'only a bug here', type: 'bug' });
    const res = await engine.consolidate();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('no-candidates');
    expect(model.calls).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Pure-logic describes (in-memory mock store — no sqlite-vec gate)
// ---------------------------------------------------------------------------

/** Minimal in-memory store for logic tests (KV tracked; doc/vec recorded). */
function mockStore(opts?: { failIndexDocFirst?: boolean }): {
  store: Store;
  docIds: Set<string>;
  vecIds: Set<string>;
} {
  const kv = new Map<string, unknown>();
  const docIds = new Set<string>();
  const vecIds = new Set<string>();
  let indexDocFailed = opts?.failIndexDocFirst !== true;
  const store = {
    projectId: 'proj-mock' as ProjectId,
    getState: <T>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setState: <T>(key: string, value: T): void => {
      kv.set(key, value);
    },
    indexDoc: (d: { id: string }) => {
      // When armed, the FIRST indexDoc throws (forcing saveInternal to reject)
      // then re-arms to normal — used to prove a rejected op does not poison
      // the single-flight chain.
      if (opts?.failIndexDocFirst && !indexDocFailed) {
        indexDocFailed = true;
        throw new Error('transient indexDoc failure');
      }
      docIds.add(d.id);
    },
    deleteDoc: (id: string) => {
      docIds.delete(id);
    },
    searchFt: () => [],
    upsertVec: (id: string) => {
      vecIds.add(id);
    },
    deleteVec: (id: string) => {
      vecIds.delete(id);
    },
    knn: () => [],
    countDocs: () => docIds.size,
    countVecs: () => vecIds.size,
    exportMarkdown: async () => [],
    close: async () => {},
  } as unknown as Store;
  return { store, docIds, vecIds };
}

describe('memory engine — degraded (read-only) path', () => {
  it('status reports degraded when storeDegraded is true', () => {
    const { store } = mockStore();
    const engine = createMemoryEngine({
      store,
      root: '/proj',
      projectId: 'proj-mock' as ProjectId,
      embed,
      storeDegraded: true,
    });
    expect(engine.status().degraded).toBe(true);
  });

  it('save throws a clear error on a read-only handle (does not fail mid-op)', async () => {
    const { store } = mockStore();
    const engine = createMemoryEngine({
      store,
      root: '/proj',
      projectId: 'proj-mock' as ProjectId,
      embed,
      storeDegraded: true,
    });
    await expect(engine.save({ content: 'x' })).rejects.toThrow(/read-only/);
  });

  it('forget throws a clear error on a read-only handle', () => {
    const { store } = mockStore();
    const engine = createMemoryEngine({
      store,
      root: '/proj',
      projectId: 'proj-mock' as ProjectId,
      embed,
      storeDegraded: true,
    });
    expect(() => engine.forget(['x'])).toThrow(/read-only/);
  });
});

describe('memory engine — single-flight serialization', () => {
  it('serializes concurrent saves: all N observations land in the index', async () => {
    const { store } = mockStore();
    const engine = createMemoryEngine({
      store,
      root: '/proj',
      projectId: 'proj-mock' as ProjectId,
      embed,
    });
    // Fire 5 concurrent saves with a shared session. Without serialization, the
    // memory:index + memory:sessions RMW would race and lose entries; with the
    // single-flight chain every save lands distinctly.
    const contents = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const saved = await Promise.all(
      contents.map((c) => engine.save({ content: c, sessionId: 'sess-1' })),
    );
    const ids = saved.map((o) => o.id);
    expect(new Set(ids).size).toBe(5); // all distinct
    expect(getObservationIds(store)).toHaveLength(5);
    const session = engine.sessions().find((s) => s.id === 'sess-1');
    expect(session?.count).toBe(5); // no lost increment
  });

  it('a rejected op does not poison the chain (next save still lands)', async () => {
    // A store whose FIRST indexDoc throws (forcing saveInternal to reject),
    // then re-arms to normal. Proves the single-flight chain advances past a
    // rejected op instead of hanging the queue on the rejection.
    const { store } = mockStore({ failIndexDocFirst: true });
    const engine = createMemoryEngine({
      store,
      root: '/proj',
      projectId: 'proj-mock' as ProjectId,
      embed,
    });
    await expect(engine.save({ content: 'first' })).rejects.toThrow(/indexDoc/);
    // The second save must NOT be blocked by the first's rejection.
    const o2 = await engine.save({ content: 'second' });
    expect(getObservationIds(store)).toEqual([o2.id]);
  });
});
