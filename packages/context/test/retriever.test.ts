import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore, type Store, vecAvailability } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeEmbedFn } from '../src/embedders/index.js';
import {
  createRetriever,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SNIPPET_WINDOW_TOKENS,
  windowSnippet,
} from '../src/retriever.js';
import type { ChunkMeta, EmbedFn } from '../src/types.js';

// CI gate: opening a store loads sqlite-vec, which ships a per-platform native
// binary. Probe-load it ONCE synchronously; if absent on this host, skip the
// store-backed describes with a labelled reason (mirrors vec.test.ts /
// readonly.test.ts — full suite stays green offline on unsupported platforms).
const VEC_PROBE = vecAvailability();
const describeStore = VEC_PROBE.ok ? describe : describe.skip;
const storeLabel = VEC_PROBE.ok
  ? 'retriever (hybrid search)'
  : `retriever (hybrid search) [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

// Independent SHA-256 so tests cross-check the contract rather than re-stating
// the chunker's own helper.
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// 384-dim deterministic placement helpers (same style as store/test/vec.test.ts).
const DIM = 384;
function vec(entries: Array<[number, number]>): Float32Array {
  const v = new Float32Array(DIM);
  for (const [idx, val] of entries) v[idx] = val;
  return v;
}
const BASE = vec([[0, 1]]);
const FAR = vec([[1, 1]]); // L2 from BASE ≈ 1.41 — far from BASE

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-ctx-retriever-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// windowSnippet — pure unit (no store, no sqlite-vec gate)
// ---------------------------------------------------------------------------

describe('windowSnippet (pure)', () => {
  it('wraps query-term matches with <<…>> markers (mirrors FTS5 convention)', () => {
    const out = windowSnippet('the hybrid retriever coordinates fusion', 'fusion', 16);
    expect(out).toContain('<<fusion>>');
    // non-matching words are passed through unwrapped
    expect(out).toContain('hybrid');
    expect(out).not.toContain('<<hybrid>>');
  });

  it('matches case-insensitively on the alphanumeric core (keeps original casing + punctuation)', () => {
    const out = windowSnippet('See ContextEngine, it fuses.', 'contextengine', 16);
    expect(out).toContain('<<ContextEngine,>>');
  });

  it('takes the first `windowTokens` words and marks truncation when content exceeds the window', () => {
    const content = 'one two three four five six seven eight nine ten';
    const out = windowSnippet(content, 'one', 3);
    // first 3 words, no match-padding; trailing truncation marker appended
    expect(out.startsWith('<<one>> two three')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('four');
  });

  it('returns the whole short content (highlighted, no truncation marker) when under the window', () => {
    const out = windowSnippet('short snippet', 'short', 16);
    expect(out).toBe('<<short>> snippet');
    expect(out.endsWith(' …')).toBe(false);
  });

  it('returns "" for empty / whitespace-only content', () => {
    expect(windowSnippet('', 'x', 16)).toBe('');
    expect(windowSnippet('   \n\t ', 'x', 16)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Degraded knn path — stubbed store (no sqlite-vec dependency; deterministic)
// ---------------------------------------------------------------------------

/** Minimal Store stub: only `searchFt`/`knn` are exercised by the retriever. */
function stubStore(overrides: { searchFt: Store['searchFt']; knn: Store['knn'] }): Store {
  return {
    projectId: createProjectId(),
    searchFt: overrides.searchFt,
    knn: overrides.knn,
    getState: () => null,
    setState: () => undefined,
    indexDoc: () => undefined,
    upsertVec: () => undefined,
    countDocs: () => 0,
    countVecs: () => 0,
    exportMarkdown: async () => [],
    close: async () => undefined,
  };
}

describe('retriever (degraded paths, stubbed store)', () => {
  it('a knn() throw degrades to BM25-only without crashing (F8)', async () => {
    const store = stubStore({
      searchFt: () => [
        {
          id: 'k1',
          source: 'codebase',
          score: -1,
          snippet: 'the <<matching>> bm25 only pathway',
        },
      ],
      knn: () => {
        throw new Error('vec0 virtual table missing');
      },
    });
    const r = createRetriever({ store, embed: fakeEmbedFn() });
    const res = await r.search('matching');

    expect(res.mode).toBe('bm25-only');
    expect(res.degraded).toBe(true);
    // BM25 hit still returned — degrade, don't crash.
    expect(res.results.map((h) => h.id)).toContain('k1');
    expect(res.results[0]?.snippet).toBe('the <<matching>> bm25 only pathway');
  });

  it('a searchFt() throw still completes (vec leg may carry results; degraded:true)', async () => {
    const store = stubStore({
      searchFt: () => {
        throw new Error('docs_fts table missing');
      },
      knn: () => [{ id: 'v1', source: 'codebase', score: 0.1 }],
    });
    const r = createRetriever({ store, embed: fakeEmbedFn() });
    const res = await r.search('anything');

    // No readDoc → the vec hit is unhydrated (empty snippet) but still ranked.
    expect(res.degraded).toBe(true);
    expect(res.results.map((h) => h.id)).toContain('v1');
  });
});

// ---------------------------------------------------------------------------
// Store-backed hybrid search (gated on sqlite-vec)
// ---------------------------------------------------------------------------

// Build a ChunkMeta exactly as the indexer (t6) will, so the retriever's
// backfill path is exercised against the real shape.
function chunkMeta(path: string, chunkIndex = 0): ChunkMeta {
  return {
    path,
    parentDocId: sha256(path),
    chunkIndex,
    language: 'typescript',
    sha256: sha256(`content-of-${path}-${chunkIndex}`),
  };
}

describeStore(storeLabel, () => {
  it('AC-2: returns the relevant chunk with a <<…>>-windowed snippet under the local embedder (hybrid)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const path = 'src/retriever.ts';
      const content =
        'The hybrid retriever coordinates BM25 and vector results through reciprocal rank fusion.';
      store.indexDoc({ id: 'c1', source: 'codebase', content, meta: chunkMeta(path) });
      store.upsertVec('c1', await fakeEmbedFn()(content), { source: 'codebase' });

      const r = createRetriever({ store, embed: fakeEmbedFn() });
      const res = await r.search('fusion');

      expect(res.mode).toBe('hybrid');
      expect(res.degraded).toBe(false);
      expect(res.results.length).toBeGreaterThan(0);
      const top = res.results[0];
      if (!top) throw new Error('expected a top hit');
      expect(top.id).toBe('c1');
      // BM25 snippet reused verbatim — carries the FTS5 match markers.
      expect(top.snippet).toMatch(/<<.*fusion.*>>/i);
      // path/parentDocId backfilled from docs.meta (ChunkMeta).
      expect(top.path).toBe(path);
      expect(top.parentDocId).toBe(sha256(path));
      expect(top.meta.language).toBe('typescript');
      expect(res.consumedTokens).toBeGreaterThan(0);
      expect(res.truncated).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('AC-4 / F8: kind:"none" (embed throws) degrades to BM25-only, mode:"bm25-only", degraded:true', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const content = 'A searchable document about discipline and recall.';
      store.indexDoc({ id: 'd1', source: 'docs', content, meta: chunkMeta('docs/d1.md') });

      const noneEmbed: EmbedFn = async () => {
        throw new Error('embedder disabled (kind:"none")');
      };
      const r = createRetriever({ store, embed: noneEmbed });
      const res = await r.search('discipline');

      expect(res.mode).toBe('bm25-only');
      expect(res.degraded).toBe(true);
      // BM25 hit is still returned — degrade, don't crash.
      expect(res.results.map((h) => h.id)).toContain('d1');
      expect(res.results[0]?.snippet).toMatch(/<<.*discipline.*>>/i);
    } finally {
      await store.close();
    }
  });

  it('DS-6 / budget: a small budget caps the packed set and sets truncated:true (top hit always admitted)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // Two distinct files, each lexically matching the query.
      store.indexDoc({
        id: 'b1',
        source: 'codebase',
        content: 'alpha budget packer test document one with enough words',
        meta: chunkMeta('src/a.ts'),
      });
      store.indexDoc({
        id: 'b2',
        source: 'codebase',
        content: 'alpha budget packer test document two with enough words',
        meta: chunkMeta('src/b.ts'),
      });

      const r = createRetriever({ store, embed: fakeEmbedFn() });
      // Tiny budget: first hit (~10 tokens) admitted; second would exceed.
      const res = await r.search('alpha', { budgetTokens: 3 });

      expect(res.truncated).toBe(true);
      expect(res.results.length).toBeGreaterThanOrEqual(1);
      // The top hit is always admitted even though it alone exceeds budget.
      expect(res.consumedTokens).toBeGreaterThan(3);
    } finally {
      await store.close();
    }
  });

  it('DS-6 / collapse: duplicate parentDocId collapses to the top-scoring chunk per file', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const path = 'src/same.ts';
      // Two chunks from the SAME file (same parentDocId), both match the query.
      store.indexDoc({
        id: 'p1',
        source: 'codebase',
        content: 'collapse duplicate parent first chunk matches the query term',
        meta: chunkMeta(path, 0),
      });
      store.indexDoc({
        id: 'p2',
        source: 'codebase',
        content: 'collapse duplicate parent second chunk matches the query term',
        meta: chunkMeta(path, 1),
      });

      const r = createRetriever({ store, embed: fakeEmbedFn() });
      const res = await r.search('collapse');
      // Only ONE chunk from `path` survives the parent-collapse.
      const fromSameFile = res.results.filter((h) => h.parentDocId === sha256(path));
      expect(fromSameFile.length).toBe(1);
    } finally {
      await store.close();
    }
  });

  it('passes opts.source through to both legs (filters the result set)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.indexDoc({
        id: 's1',
        source: 'codebase',
        content: 'source filter codebase document mentioning filterable',
        meta: chunkMeta('src/c.ts'),
      });
      store.indexDoc({
        id: 's2',
        source: 'docs',
        content: 'source filter docs document mentioning filterable',
        meta: chunkMeta('docs/d.md'),
      });

      const r = createRetriever({ store, embed: fakeEmbedFn() });
      const res = await r.search('filterable', { source: 'docs' });
      expect(res.results.length).toBeGreaterThan(0);
      expect(res.results.every((h) => h.source === 'docs')).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('kNN-only hit is hydrated via readDoc into a windowed snippet (F7 fallback)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // chunkA: lexical match for the query (BM25), vector FAR from BASE.
      store.indexDoc({
        id: 'h1',
        source: 'codebase',
        content: 'lexical alpha signal in chunk A only',
        meta: chunkMeta('src/a.ts'),
      });
      store.upsertVec('h1', FAR, { source: 'codebase' });
      // chunkB: NO lexical match for 'alpha', but its vector IS BASE → kNN rank 1.
      const bContent = 'semantic beta gamma delta epsilon zeta content';
      store.indexDoc({
        id: 'h2',
        source: 'codebase',
        content: bContent,
        meta: chunkMeta('src/b.ts'),
      });
      store.upsertVec('h2', BASE, { source: 'codebase' });

      // Query embeds to BASE → kNN returns h2 (distance 0) ahead of h1.
      const embedBase: EmbedFn = async () => BASE;
      const docs = new Map<string, { content: string; meta?: ChunkMeta }>([
        ['h2', { content: bContent, meta: chunkMeta('src/b.ts') }],
      ]);
      const r = createRetriever({
        store,
        embed: embedBase,
        opts: { readDoc: (id) => docs.get(id) ?? null },
      });

      const res = await r.search('alpha');
      expect(res.mode).toBe('hybrid');
      // h2 is kNN-only (no 'alpha' in its content); it must be hydrated.
      const h2 = res.results.find((h) => h.id === 'h2');
      expect(h2).toBeTruthy();
      if (!h2) throw new Error('expected h2 in results');
      expect(h2.snippet.length).toBeGreaterThan(0);
      // windowed prefix of bContent (no 'alpha' to highlight).
      expect(bContent.startsWith(h2.snippet.replace(/ …$/, ''))).toBe(true);
      // path/parentDocId backfilled from the hydrated ChunkMeta.
      expect(h2.path).toBe('src/b.ts');
      expect(h2.parentDocId).toBe(sha256('src/b.ts'));
    } finally {
      await store.close();
    }
  });

  it('kNN-only hit without a readDoc hydrator keeps its rank but emits an empty snippet', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.indexDoc({
        id: 'n1',
        source: 'codebase',
        content: 'lexical alpha signal in chunk A only',
        meta: chunkMeta('src/a.ts'),
      });
      store.upsertVec('n1', FAR, { source: 'codebase' });
      const bContent = 'semantic beta gamma delta epsilon zeta content';
      store.indexDoc({
        id: 'n2',
        source: 'codebase',
        content: bContent,
        meta: chunkMeta('src/b.ts'),
      });
      store.upsertVec('n2', BASE, { source: 'codebase' });

      const embedBase: EmbedFn = async () => BASE;
      // No readDoc: the kNN-only n2 cannot be windowed.
      const r = createRetriever({ store, embed: embedBase });
      const res = await r.search('alpha');

      const n2 = res.results.find((h) => h.id === 'n2');
      expect(n2).toBeTruthy();
      if (!n2) throw new Error('expected n2 in results');
      // Ranked (present) but unhydrated → empty snippet + empty path.
      expect(n2.snippet).toBe('');
      expect(n2.path).toBe('');
      expect(n2.parentDocId).toBe('');
    } finally {
      await store.close();
    }
  });

  it('no matches → empty results, not degraded, within budget', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // Index a doc that does NOT lexically match the query, and NO vector —
      // so BM25 returns [] and kNN runs against an empty vec table (also []).
      // (A populated vec table would always return *something* for kNN, since
      // kNN returns nearest neighbors regardless of lexical relevance.)
      store.indexDoc({
        id: 'x1',
        source: 'codebase',
        content: 'completely unrelated content with no query overlap',
        meta: chunkMeta('src/x.ts'),
      });

      const r = createRetriever({ store, embed: fakeEmbedFn() });
      const res = await r.search('zzzznomatch');
      expect(res.results).toEqual([]);
      expect(res.degraded).toBe(false);
      expect(res.truncated).toBe(false);
      expect(res.consumedTokens).toBe(0);
    } finally {
      await store.close();
    }
  });

  it('respects per-retriever defaults (limit/budget/snippetWindow constants)', async () => {
    expect(DEFAULT_SEARCH_LIMIT).toBe(10);
    expect(DEFAULT_BUDGET_TOKENS).toBe(4096);
    expect(DEFAULT_SNIPPET_WINDOW_TOKENS).toBe(16);
  });
});
