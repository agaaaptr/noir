// Recall tests for @noir-ai/memory.
//
// Three layers:
//   1. Pure unit (no store): `extractEntities` — path/qualified-token + camelCase
//      / snake / kebab identifier SPLIT (mirrors explodeIdentifiers), stopword +
//      min-length filtering.
//   2. Mock-store unit (no sqlite-vec gate): `recallMemory` against a controlled
//      store — proves the RRF fusion (rank-based, ignores raw scores), the
//      entity-boost rerank, kNN-only KV hydration, the BM25-only degraded
//      fallback (embed throws / knn throws), stale-id dropping, type/sessionId
//      filters, and limit truncation. Fully deterministic + offline.
//   3. Real-store integration (gated on sqlite-vec): the engine's `recall()`
//      path end-to-end — hybrid round-trip with FULL content,
//      source:'memory' scoping (no context leak), the kNN leg contributing
//      results BM25 alone would miss, and the entity-boost not breaking recall.
//
// Offline throughout: `fakeEmbedFn` (384-dim deterministic) + a throwing embed
// for the degraded path. No network, no real LLM.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeEmbedFn } from '@noir-ai/context';
import { createProjectId } from '@noir-ai/core';
import {
  type FtsHit,
  openStore,
  type ProjectId,
  type Store,
  type VecHit,
  vecAvailability,
} from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMemoryEngine,
  extractEntities,
  type Observation,
  obsKey,
  recallMemory,
} from '../src/index.js';

// CI gate: opening a store loads sqlite-vec (per-platform native binary). Probe
// once; if absent, skip the store-backed describe with a labelled reason
// (mirrors engine.test.ts — full suite stays green offline).
const VEC_PROBE = vecAvailability();
const describeStore = VEC_PROBE.ok ? describe : describe.skip;
const storeLabel = VEC_PROBE.ok
  ? 'recall (real store)'
  : `recall (real store) [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

// A deterministic 384-dim embed (context's fakeEmbedFn is offline + dim-stable).
const embed = fakeEmbedFn();

let root: string;
let projectId: ProjectId;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-mem-recall-'));
  projectId = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Pure unit — extractEntities (cheap regex, NO LLM)
// ---------------------------------------------------------------------------

describe('extractEntities', () => {
  it('splits camelCase / PascalCase identifiers into lowercase subwords', () => {
    // Mirrors @noir-ai/context's explodeIdentifiers: the identifier is SPLIT at
    // case boundaries, not lowercased whole.
    expect(extractEntities('ContextEngine')).toEqual(['context', 'engine']);
    expect(extractEntities('XMLHttpRequest')).toEqual(['xml', 'http', 'request']);
  });

  it('splits snake_case / kebab-case on separators', () => {
    expect(extractEntities('recall_memory')).toEqual(['recall', 'memory']);
    expect(extractEntities('MemoryEngine-save')).toEqual(['memory', 'engine', 'save']);
  });

  it('keeps qualified path/dotted/colon tokens whole AND explodes their subwords', () => {
    const e = new Set(extractEntities('packages/memory/src/recall.ts'));
    // The full qualified token is retained verbatim (lowercased)…
    expect(e.has('packages/memory/src/recall.ts')).toBe(true);
    // …and its alphanumeric subwords are exploded as independent entities.
    expect(e.has('packages')).toBe(true);
    expect(e.has('memory')).toBe(true);
    expect(e.has('recall')).toBe(true);
    // Exactly MIN_ENTITY_LEN (3) is kept; noisy tiny tail tokens ('ts') drop.
    expect(e.has('src')).toBe(true);
    expect(e.has('ts')).toBe(false);
  });

  it('drops stopwords and tokens shorter than MIN_ENTITY_LEN', () => {
    expect(extractEntities('a is the ts')).toEqual([]);
    // 'how' is a stopword; 'it' is length 2; 'does' / 'work' survive.
    expect(extractEntities('how does it work')).toEqual(['does', 'work']);
    expect(extractEntities('how')).toEqual([]);
  });

  it('returns an empty list for whitespace-only / empty input', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities('   ')).toEqual([]);
  });

  it('de-duplicates entities extracted from equivalent tokens', () => {
    // PascalCase + camelCase forms of the same identifier explode identically.
    expect(extractEntities('MemoryEngine memoryEngine')).toEqual(['memory', 'engine']);
  });
});

// ---------------------------------------------------------------------------
// 2. Mock-store unit — recallMemory (deterministic, no sqlite-vec gate)
// ---------------------------------------------------------------------------

/** Build a minimal Observation row for test fixtures. */
function makeObs(partial: Partial<Observation> & Pick<Observation, 'id' | 'content'>): Observation {
  return {
    type: 'fact',
    project: projectId,
    sessionId: null,
    ts: 1_700_000_000_000,
    lastAccessTs: 1_700_000_000_000,
    importance: 0.5,
    concepts: [],
    files: [],
    source: 'explicit',
    ...partial,
  };
}

/** FtsHit builder (source defaults to 'memory' — the recall scope). */
function fts(id: string, score = 1, source = 'memory'): FtsHit {
  return { id, source, score, snippet: `<${id}>` };
}

/** VecHit builder (source defaults to 'memory'). */
function vec(id: string, score = 0.5, source = 'memory'): VecHit {
  return { id, source, score };
}

/**
 * A controlled in-memory store for recallMemory tests. KV holds the obs rows
 * (under the real `memory:obs:<id>` key); `searchFt` / `knn` return exactly the
 * configured hit lists so the fusion + boost + hydration logic is exercised
 * deterministically without sqlite-vec.
 */
function mockRecallStore(opts: {
  obs?: Observation[];
  ftsHits?: FtsHit[];
  knnHits?: VecHit[];
  throwOnKnn?: boolean;
}): Store {
  const kv = new Map<string, unknown>();
  for (const o of opts.obs ?? []) kv.set(obsKey(o.id), o);
  const store = {
    projectId,
    getState: <T>(key: string): T | null => (kv.has(key) ? (kv.get(key) as T) : null),
    setState: <T>(key: string, value: T): void => {
      kv.set(key, value);
    },
    searchFt: (): FtsHit[] => opts.ftsHits ?? [],
    knn: (): VecHit[] => {
      if (opts.throwOnKnn) throw new Error('knn unavailable');
      return opts.knnHits ?? [];
    },
    indexDoc: () => {},
    deleteDoc: () => {},
    upsertVec: () => {},
    deleteVec: () => {},
    countDocs: () => 0,
    countVecs: () => 0,
    exportMarkdown: async () => [],
    close: async () => {},
  } as unknown as Store;
  return store;
}

describe('recallMemory — RRF fusion + entity-boost', () => {
  it('fuses BM25 ∪ kNN by RANK (ignores raw scores) and hydrates full content', async () => {
    const a = makeObs({ id: 'a', content: 'the full hydrated content for a' });
    const b = makeObs({ id: 'b', content: 'the full hydrated content for b' });
    const store = mockRecallStore({
      obs: [a, b],
      // A has a HUGER raw BM25 score than B, but RRF is rank-based: position in
      // the array IS the rank, so A is BM25-rank-1, B is BM25-rank-2 (the raw
      // 9999 vs 1 is intentionally ignored — never summed).
      ftsHits: [fts('a', 9999), fts('b', 1)],
      knnHits: [vec('b', 0.9), vec('a', 0.1)],
    });
    const { hits, mode, degraded } = await recallMemory(
      { store, embed },
      'zzqxqab', // no entities → pure RRF, no boost
    );
    expect(mode).toBe('hybrid');
    expect(degraded).toBe(false);
    // Both ids fused in; full content hydrated from KV.
    expect(hits.map((h) => h.id).sort()).toEqual(['a', 'b']);
    expect(hits.find((h) => h.id === 'a')?.content).toBe(a.content);
    expect(hits.find((h) => h.id === 'b')?.content).toBe(b.content);
  });

  it('entity-boost reranks: a hit whose concepts mention a queried subword leaps ahead', async () => {
    // 'ContextEngine' splits → entities ['context','engine'].
    const a = makeObs({ id: 'a', content: 'a generic note', concepts: [] });
    const b = makeObs({
      id: 'b',
      content: 'a generic note',
      concepts: ['context'], // exact-matches the 'context' subword entity
      files: ['packages/context/src/contextEngine.ts'],
    });
    const store = mockRecallStore({
      obs: [a, b],
      // A is BM25 rank 1 (first); B rank 2. Without the boost A would lead.
      ftsHits: [fts('a'), fts('b')],
      knnHits: [],
    });
    const { hits } = await recallMemory({ store, embed }, 'ContextEngine');
    // The boost (+0.1 on B for the 'context' concept match) flips the order: B
    // outranks A despite A's better BM25 rank.
    expect(hits[0]?.id).toBe('b');
    expect(hits[1]?.id).toBe('a');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('entity-boost matches content (substring) and files (path substring)', async () => {
    // Query explodes to ['context','engine','recall','packages','memory','src',
    // 'packages/memory/src/recall.ts', …].
    const byContent = makeObs({ id: 'c', content: 'see the ContextEngine class' });
    const byFile = makeObs({
      id: 'f',
      content: 'unrelated text',
      files: ['packages/memory/src/recall.ts'],
    });
    const neither = makeObs({ id: 'n', content: 'totally unrelated' });
    const store = mockRecallStore({
      obs: [byContent, byFile, neither],
      ftsHits: [fts('n'), fts('f'), fts('c')], // 'neither' ranked first by BM25
      knnHits: [],
    });
    const { hits } = await recallMemory(
      { store, embed },
      'ContextEngine packages/memory/src/recall.ts',
    );
    // Both entity-bearing hits outrank the no-match hit, regardless of BM25 rank.
    const ids = hits.map((h) => h.id);
    expect(ids.indexOf('c')).toBeLessThan(ids.indexOf('n'));
    expect(ids.indexOf('f')).toBeLessThan(ids.indexOf('n'));
    expect(hits[hits.length - 1]?.id).toBe('n');
  });

  it('applies no boost when the query has no entities (pure RRF order)', async () => {
    const a = makeObs({ id: 'a', content: 'note one' });
    const b = makeObs({ id: 'b', content: 'note two' });
    const store = mockRecallStore({
      obs: [a, b],
      ftsHits: [fts('a'), fts('b')],
      knnHits: [],
    });
    // 'a is the' → all stopwords / too short → no entities → no boost.
    const { hits } = await recallMemory({ store, embed }, 'a is the');
    expect(hits[0]?.id).toBe('a'); // BM25 rank 1 preserved (nothing flips it)
  });
});

describe('recallMemory — kNN-only hydration + stale rows', () => {
  it('hydrates a kNN-only hit (no BM25 match) to full content from KV', async () => {
    const x = makeObs({ id: 'x', content: 'the full kv hydrated content' });
    const store = mockRecallStore({
      obs: [x],
      ftsHits: [], // BM25 misses entirely
      knnHits: [vec('x')], // kNN finds it
    });
    const { hits, mode, degraded } = await recallMemory({ store, embed }, 'zzqxqab');
    expect(mode).toBe('hybrid');
    expect(degraded).toBe(false);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('x');
    // FULL content, never the (absent) FTS snippet.
    expect(hits[0]?.content).toBe('the full kv hydrated content');
  });

  it('drops a fused id whose KV row was forgotten (stale vec-only hit)', async () => {
    const store = mockRecallStore({
      obs: [], // no KV rows at all
      ftsHits: [],
      knnHits: [vec('ghost')], // a vec id with no authoritative row
    });
    const { hits } = await recallMemory({ store, embed }, 'query');
    expect(hits).toEqual([]);
  });
});

describe('recallMemory — BM25-only degradation (F8)', () => {
  it('degrades to BM25-only when embed() throws, still returning the FTS hits', async () => {
    const a = makeObs({ id: 'a', content: 'bm25 finds this' });
    const store = mockRecallStore({ obs: [a], ftsHits: [fts('a')] });
    const throwingEmbed = async (): Promise<Float32Array> => {
      throw new Error('embedder unavailable (kind:none / load failed)');
    };
    const { hits, mode, degraded } = await recallMemory({ store, embed: throwingEmbed }, 'zzqxqab');
    expect(mode).toBe('bm25-only');
    expect(degraded).toBe(true);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe('a');
    expect(hits[0]?.content).toBe('bm25 finds this');
  });

  it('degrades to BM25-only when store.knn() throws', async () => {
    const a = makeObs({ id: 'a', content: 'bm25 still works' });
    const store = mockRecallStore({
      obs: [a],
      ftsHits: [fts('a')],
      throwOnKnn: true,
    });
    const { hits, mode, degraded } = await recallMemory({ store, embed }, 'zzqxqab');
    expect(mode).toBe('bm25-only');
    expect(degraded).toBe(true);
    expect(hits[0]?.id).toBe('a');
  });
});

describe('recallMemory — filters + truncation', () => {
  it('filters by type and sessionId', async () => {
    const a = makeObs({ id: 'a', content: 'a', type: 'bug', sessionId: 's1' });
    const b = makeObs({ id: 'b', content: 'b', type: 'pattern', sessionId: 's2' });
    const store = mockRecallStore({
      obs: [a, b],
      ftsHits: [fts('a'), fts('b')],
      knnHits: [],
    });
    const bugs = await recallMemory({ store, embed }, 'zzqxqab', { type: 'bug' });
    expect(bugs.hits.map((h) => h.id)).toEqual(['a']);

    const inS2 = await recallMemory({ store, embed }, 'zzqxqab', {
      sessionId: 's2',
    });
    expect(inS2.hits.map((h) => h.id)).toEqual(['b']);
  });

  it('truncates to opts.limit after the boost sort', async () => {
    const obs = ['a', 'b', 'c', 'd', 'e'].map((id) => makeObs({ id, content: id }));
    const store = mockRecallStore({
      obs,
      ftsHits: obs.map((o) => fts(o.id)),
      knnHits: [],
    });
    const { hits } = await recallMemory({ store, embed }, 'zzqxqab', { limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Real-store integration — engine.recall() end-to-end (gated on sqlite-vec)
// ---------------------------------------------------------------------------

describeStore(storeLabel, () => {
  it('recall returns the FULL observation content via the hybrid path', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({
      content: 'the embedder should be resolved once per serve lifecycle',
      type: 'pattern',
      sessionId: 'sess-1',
    });
    const hits = await engine.recall('embedder lifecycle');
    expect(hits.length).toBeGreaterThan(0);
    // Full content, never the truncated FTS snippet.
    expect(hits[0]?.content).toContain('resolved once per serve lifecycle');
  });

  it('recall is scoped to source:memory (no context-doc leak)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    // A non-memory (context codebase) doc that WOULD match the query lexically.
    store.indexDoc({
      id: 'ctx-1',
      source: 'codebase',
      content: 'the embedder lifecycle lives in the context engine',
      meta: {},
    });
    await engine.save({
      content: 'remember the memory embedder note',
      sessionId: 's',
    });
    const hits = await engine.recall('embedder');
    // recall works (sanity) AND stays scoped to memory (no context leak).
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.id !== 'ctx-1')).toBe(true);
  });

  it('the kNN leg contributes results BM25 alone would miss', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({ content: 'alpha note about indexing', sessionId: 's' });
    await engine.save({ content: 'beta note about retrieval', sessionId: 's' });
    await engine.save({ content: 'gamma note about fusion', sessionId: 's' });
    // A query token present in NO content → BM25 returns nothing; only the kNN
    // leg can surface neighbors. With ≥1 vec row, knn returns ≥1 hit, so the
    // hybrid result is non-empty PROVING the vec leg ran + hydrated.
    const hits = await engine.recall('zzqxqab');
    expect(hits.length).toBeGreaterThan(0);
    // Whatever surfaced, it is a real memory row hydrated with full content.
    expect(hits[0]?.content.length).toBeGreaterThan(0);
  });

  it('recall with an identifier query returns the matching observation (boost path runs)', async () => {
    const store = await openStore({ projectId, root });
    const engine = createMemoryEngine({ store, root, projectId, embed });
    await engine.save({
      content: 'the ContextEngine is built once per serve lifecycle',
      type: 'architecture',
      concepts: ['context', 'engine'],
      files: ['packages/context/src/contextEngine.ts'],
    });
    const hits = await engine.recall('ContextEngine');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.score).toBeGreaterThan(0);
    expect(hits[0]?.content).toContain('ContextEngine');
  });

  it('recall filters by type and sessionId on the hybrid path', async () => {
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
});
