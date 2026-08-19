// Hybrid retriever for @noir-ai/context (slice S6, task t7).
//
// Pipeline (spec F6, §8 "Query → BM25+vec → RRF → budget → snippets"):
//   search(query)
//     │
//     ├─ store.searchFt(query, {limit, source})        → FtsHit[]  (BM25, with
//     │                                                  FTS5 16-token windowed
//     │                                                  snippet + docs.meta)
//     ├─ store.knn(await embed(query), {limit, source}) → VecHit[]  (cosine kNN,
//     │                                                  L2-normalized vectors)
//     │
//     ├─ fuseRrf(bm25, knn, {k:60, weights:[0.5,0.5]})  → rank-based RRF fusion
//     │                                                  (NEVER sums raw
//     │                                                  BM25+cosine scores)
//     │
//     ├─ enrich each fused id:
//     │    • BM25 hit      → reuse FtsHit.snippet VERBATIM (F7 — never truncate);
//     │                       path/parentDocId backfilled from docs.meta (ChunkMeta)
//     │    • kNN-only hit   → window-extract a snippet from `readDoc(id)` (the
//     │                       chunk's content) — vec0 carries no meta column, so
//     │                       without a hydrator the hit degrades to an empty
//     │                       snippet but KEEPS ITS RANK (F8 spirit: never crash,
//     │                       never drop a ranked semantic hit on a missing window)
//     │
//     ├─ collapse duplicate parentDocId (keep the top-scoring chunk per parent —
//     │    one file can't flood the result set). Unhydrated kNN-only hits
//     │    (empty parentDocId) collapse on their unique id, so they never merge.
//     │
//     └─ greedy token-budget fill (default 4096) over the collapsed list:
//          accumulate estimateTokens(snippet) until budgetTokens; the top hit is
//          always admitted even if it alone exceeds the budget (avoid returning
//          zero results for one large hit). truncated:true iff the budget cut
//          exhausted before the budget.
//
// Degradation (F8): when the embedder is unavailable — `kind:'none'`, a native
// load failure, a provider error, OR `knn()` itself threw — `search` falls back
// to BM25-only and the payload carries `degraded:true, mode:'bm25-only'`. The
// embedder signals unavailability by throwing from `embed()` (the `'none'`
// factory does exactly that), so the retriever needs no a-priori knowledge of
// the embedder kind — the throw IS the signal. A BM25 throw (e.g. a foreign
// read-only DB missing `docs_fts`) is also caught: search degrades to an empty
// or vec-only result set rather than crashing.
//
// Mode truthfulness: beyond the bm25-only fallback there is a softer
// degradation — `'knn'`. When the kNN leg ran successfully but a kNN-only hit
// could not be hydrated (no `readDoc` wired, or the source doc was
// deleted/degraded), the hit keeps its rank but carries an empty snippet, and
// the payload carries `mode:'knn'` so the caller knows it did not receive full
// hybrid snippet quality. `'hybrid'` is reserved for the case where both legs
// ran AND every hit got a real windowed snippet.
//
// Hard rules honored (see the slice brief):
//   • Reuses the existing Store API only — no getDoc added, no schema migration.
//   • RRF k=60 RANK-BASED (no score normalization; raw scores never summed).
//   • BM25 snippets reused verbatim (never truncated); kNN windows are prefix
//     windows with `<<term>>` highlight to mirror the FTS5 snippet convention.
//   • Canonical ProjectId only (carried by the store); in-process only.

import { estimateTokens } from './chunker.js';
import { DEFAULT_RRF_K, fuseRrf } from './rrf.js';
import type {
  ChunkMeta,
  EmbedFn,
  FtsHit,
  RetrieverHit,
  RetrieverMeta,
  RRFWeights,
  SearchMode,
  SearchResult,
  SourceKind,
  Store,
  VecHit,
} from './types.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default per-query hit cap applied to BOTH the BM25 and kNN legs so RRF has
 * equal-depth lists to fuse (matches `Store.searchFt`'s default of 10; the
 * store's `knn` default of 5 is intentionally raised here for fusion parity).
 */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Default token budget for the greedy packer (spec §6 / config `budgetTokens`). */
export const DEFAULT_BUDGET_TOKENS = 4096;

/**
 * Default snippet window for kNN-only hydration, in (estimated) tokens. Mirrors
 * the FTS5 `snippet(..., 16)` 16-token window used by `Store.searchFt` so a
 * kNN-only hit's fallback window is the same width as a BM25 hit's window.
 */
export const DEFAULT_SNIPPET_WINDOW_TOKENS = 16;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Content + meta returned by the optional {@link RetrieverOptions.readDoc}
 * hydrator. This is the shape needed to window-extract a snippet for a kNN-only
 * hit (vec0 returns no meta, and the `Store` interface exposes no read-by-id).
 */
export interface ChunkDoc {
  /** Full chunk text (the hydrator decides the source: KV, a future getDoc, …). */
  content: string;
  /** The chunk's stored metadata, if available. */
  meta?: ChunkMeta;
}

/** Tunables held for the life of the retriever (RRF + budget + hydration). */
export interface RetrieverOptions {
  /** RRF constant `k` (defaults to {@link DEFAULT_RRF_K} = 60). */
  k?: number;
  /** RRF per-retriever weights `[bm25Weight, kNNWeight]` (default `[0.5, 0.5]`). */
  weights?: RRFWeights;
  /** Default token budget (overridable per `search()` call). */
  budgetTokens?: number;
  /** kNN-only snippet window width in tokens (default 16). */
  snippetWindowTokens?: number;
  /**
   * Optional content/meta lookup for kNN-only hits. The store's `knn` returns
   * only `{id, source, score}` (vec0 has no meta column) and the `Store`
   * interface exposes no read-by-id, so without a hydrator a purely-semantic
   * hit cannot be windowed. When provided and it hits, the chunk's content is
   * prefix-windowed with `<<query-term>>` highlights (mirroring FTS5). When
   * omitted or it misses, the hit is emitted with an empty snippet — degraded
   * but ranked (F8) — AND the search result's `mode` becomes `'knn'` so the
   * caller can tell the snippet quality is degraded. The engine
   * wires this from the indexer's `readChunkContent` when a content source
   * exists.
   */
  readDoc?: (id: string) => ChunkDoc | null;
}

/** Per-call options for {@link Retriever.search}. */
export interface SearchOptions {
  /** Max hits requested from EACH leg before fusion (default 10). */
  limit?: number;
  /** Token budget for this call (defaults to the retriever's `budgetTokens`). */
  budgetTokens?: number;
  /** Restrict both legs to a single source bucket (passes through to the store). */
  source?: string;
}

/** Constructor dependencies for {@link createRetriever}. */
export interface RetrieverDeps {
  /** The store handle (the daemon's single-writer handle, or a read-only one). */
  store: Store;
  /** Query/chunk embedder. A throw on `embed(query)` ⇒ BM25-only fallback (F8). */
  embed: EmbedFn;
  /** Tunables + the optional kNN-only hydrator. */
  opts?: RetrieverOptions;
}

/** The retriever surface returned by {@link createRetriever}. */
export interface Retriever {
  search(query: string, opts?: SearchOptions): Promise<SearchResult>;
}

// ---------------------------------------------------------------------------
// Small narrowing / windowing helpers
// ---------------------------------------------------------------------------

/**
 * Defensively narrow an `unknown` meta (from `FtsHit.meta` / `ChunkDoc.meta`)
 * to a {@link ChunkMeta}. The store types meta as `unknown`; for context chunks
 * it is the `ChunkMeta` the indexer wrote, but a foreign/legacy row may carry
 * anything. Returns `undefined` when the required `path` + `parentDocId` fields
 * are absent so the caller can fall back to empty strings rather than crash.
 */
function asChunkMeta(meta: unknown): ChunkMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const m = meta as Record<string, unknown>;
  const path = m.path;
  const parentDocId = m.parentDocId;
  // The two required fields — bail to `undefined` if either is missing/non-string
  // so callers fall back to empty strings rather than crashing.
  if (typeof path !== 'string' || typeof parentDocId !== 'string') {
    return undefined;
  }
  const chunkIndex = m.chunkIndex;
  const language = m.language;
  const sha256Val = m.sha256;
  return {
    path,
    parentDocId,
    chunkIndex: typeof chunkIndex === 'number' ? chunkIndex : 0,
    language: typeof language === 'string' ? language : 'text',
    // ChunkMeta.sha256 is required (the indexer always writes it); for a
    // foreign/legacy row that lacks it, fall back to '' rather than crash.
    sha256: typeof sha256Val === 'string' ? sha256Val : '',
  };
}

/** Project the secondary fields of a {@link ChunkMeta} onto a {@link RetrieverMeta}. */
function toRetrieverMeta(meta: ChunkMeta | undefined): RetrieverMeta {
  if (!meta) return {};
  const out: RetrieverMeta = {};
  if (meta.language) out.language = meta.language;
  if (meta.sha256) out.sha256 = meta.sha256;
  out.chunkIndex = meta.chunkIndex;
  return out;
}

/**
 * Narrow a free-form source string to a {@link SourceKind}. The indexer writes
 * valid source buckets, but the store types `source` as a plain string; an
 * unexpected value defaults to `'codebase'` rather than propagating.
 */
function asSourceKind(source: string): SourceKind {
  switch (source) {
    case 'codebase':
    case 'docs':
    case 'spec':
    case 'memory':
      return source;
    default:
      return 'codebase';
  }
}

/**
 * Extract a lowercase query-term set for highlight matching. Splits on
 * whitespace/punctuation and drops empties. Used only to wrap matching words in
 * the kNN-only prefix window with `<<…>>` markers (mirrors FTS5's convention);
 * it has no effect on ranking.
 */
function queryTermSet(query: string): Set<string> {
  const terms = query.toLowerCase().match(/[a-z0-9]+/g);
  return terms ? new Set(terms) : new Set();
}

/**
 * Build a best-effort prefix snippet for a kNN-only hit: the first
 * `windowTokens` whitespace-separated words of `content`, with any word whose
 * lowercase form is in the query-term set wrapped in `<<…>>` (mirroring FTS5's
 * `<<match>>` marker convention so BM25 and kNN snippets read the same way).
 *
 * Unlike FTS5's `snippet()` this is a PREFIX window (FTS5 picks the densest
 * window around match positions; vec0 gives us no match positions to center
 * on). Content shorter than the window is returned whole (highlighted) — it is
 * never padded or mid-word split.
 */
export function windowSnippet(content: string, query: string, windowTokens: number): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) return '';
  const terms = queryTermSet(query);
  const words = trimmed.split(/\s+/);
  const slice = words.slice(0, Math.max(1, windowTokens));
  return (
    slice
      .map((w) => {
        // Compare the alphanumeric core so trailing punctuation doesn't defeat
        // the match (e.g. `ContextEngine,` → core `contextengine`). We wrap the
        // ORIGINAL word, preserving punctuation, when its core matches.
        const core = w.toLowerCase().match(/[a-z0-9]+/)?.[0];
        if (core && terms.has(core)) return `<<${w}>>`;
        return w;
      })
      .join(' ')
      // Mark truncation only when content genuinely exceeded the window, so a
      // caller can tell a full short snippet from a truncated long one.
      .concat(words.length > slice.length ? ' …' : '')
  );
}

// ---------------------------------------------------------------------------
// Collapse + budget
// ---------------------------------------------------------------------------

/**
 * Collapse duplicate parent-docs: keep the FIRST (top-scoring, since `hits` is
 * already RRF-sorted desc) chunk per `parentDocId`. A hit with an EMPTY
 * `parentDocId` (an unhydrated kNN-only hit) collapses on its own `id`, so the
 * missing parent link can never cause two unrelated semantic hits to merge.
 */
function collapseByParent(hits: ReadonlyArray<RetrieverHit>): RetrieverHit[] {
  const seen = new Set<string>();
  const out: RetrieverHit[] = [];
  for (const hit of hits) {
    const key = hit.parentDocId || hit.id;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hit);
  }
  return out;
}

/** Outcome of a greedy budget pack. */
interface PackedResult {
  hits: RetrieverHit[];
  consumedTokens: number;
  truncated: boolean;
}

/**
 * Greedy token-budget fill over the (already collapsed) ranked list: accumulate
 * `estimateTokens(snippet)` per hit until `budgetTokens` is reached. The FIRST
 * hit is always admitted even if it alone exceeds the budget (returning zero
 * results for one over-large top hit is worse than a small budget overshoot).
 * `truncated` is `true` iff the budget stopped the iteration before the list was
 * exhausted.
 */
function packBudget(hits: ReadonlyArray<RetrieverHit>, budgetTokens: number): PackedResult {
  let consumed = 0;
  const packed: RetrieverHit[] = [];
  for (const hit of hits) {
    const tokens = estimateTokens(hit.snippet);
    if (packed.length > 0 && consumed + tokens > budgetTokens) {
      return { hits: packed, consumedTokens: consumed, truncated: true };
    }
    packed.push(hit);
    consumed += tokens;
  }
  return { hits: packed, consumedTokens: consumed, truncated: false };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a hybrid retriever over an injected store + embedder.
 *
 * The retriever owns no state beyond its configured tunables; every `search`
 * call is independent and side-effect-free (read-only against the store). It is
 * the ONLY read path for context — `context_search` (t9) delegates here. Write
 * (`indexDoc`/`upsertVec`) stays with the indexer/engine; the retriever never
 * mutates the store.
 */
export function createRetriever(deps: RetrieverDeps): Retriever {
  const { store, embed } = deps;
  const k = deps.opts?.k ?? DEFAULT_RRF_K;
  // `weights` is passed through verbatim; fuseRrf applies its own [0.5, 0.5]
  // default when undefined. (DEFAULT_RRF_WEIGHTS is `readonly` while
  // FuseRrfOptions.weights is a mutable tuple, so defaulting here would need a
  // copy — cleaner to let fuseRrf, which already handles the default, do it.)
  const weights = deps.opts?.weights;
  const defaultBudget = deps.opts?.budgetTokens ?? DEFAULT_BUDGET_TOKENS;
  const snippetWindowTokens = deps.opts?.snippetWindowTokens ?? DEFAULT_SNIPPET_WINDOW_TOKENS;
  const readDoc = deps.opts?.readDoc;

  return {
    async search(query: string, opts?: SearchOptions): Promise<SearchResult> {
      const limit = opts?.limit ?? DEFAULT_SEARCH_LIMIT;
      const budgetTokens = opts?.budgetTokens ?? defaultBudget;
      const source = opts?.source;

      // --- BM25 leg (always attempted; the cheap, always-available signal) ---
      let ftsHits: FtsHit[] = [];
      let ftsFailed = false;
      try {
        ftsHits = store.searchFt(query, { limit, source });
      } catch {
        // e.g. a foreign read-only DB with no `docs_fts` table. Keep going —
        // the vec leg may still return something; flag degraded.
        ftsFailed = true;
      }

      // --- kNN leg (attempted; any failure ⇒ BM25-only degradation, F8) ---
      let knnHits: VecHit[] = [];
      let knnFailed = false;
      try {
        const qvec = await embed(query); // throws on kind:'none' / load / provider error
        try {
          knnHits = store.knn(qvec, { limit, source });
        } catch {
          // vec table missing or query malformed — degrade to BM25-only.
          knnFailed = true;
        }
      } catch {
        // embed() threw: the embedder is unavailable. BM25-only (F8).
        knnFailed = true;
      }

      // --- RRF fusion (rank-based; raw BM25+cosine scores NEVER summed) ---
      const fused = fuseRrf(ftsHits, knnHits, { k, weights });

      // Index BM25 hits by id so each fused row can pick up its verbatim
      // snippet + ChunkMeta in O(1) (a kNN-only id simply misses here).
      const ftsById = new Map<string, FtsHit>();
      for (const h of ftsHits) {
        if (!ftsById.has(h.id)) ftsById.set(h.id, h);
      }

      // Track whether ANY kNN-only hit could not be hydrated (no readDoc, or
      // readDoc missed). When true, the search did not deliver full hybrid
      // snippet quality — surface that honestly via mode:'knn' (degraded but
      // distinct from 'bm25-only', which means the kNN leg did not run at all).
      let knnUnhydrated = false;

      // --- Enrich each fused row into a public RetrieverHit ---
      const enriched: RetrieverHit[] = fused.map((row) => {
        const fts = ftsById.get(row.id);
        if (fts) {
          // BM25 path: reuse the FTS5 windowed snippet VERBATIM (F7).
          const meta = asChunkMeta(fts.meta);
          return {
            id: row.id,
            source: asSourceKind(row.source),
            score: row.score,
            snippet: fts.snippet,
            path: meta?.path ?? '',
            parentDocId: meta?.parentDocId ?? '',
            meta: toRetrieverMeta(meta),
          };
        }
        // kNN-only path: hydrate content + meta to window-extract a snippet.
        if (readDoc) {
          const doc = readDoc(row.id);
          if (doc) {
            const meta = asChunkMeta(doc.meta);
            return {
              id: row.id,
              source: asSourceKind(row.source),
              score: row.score,
              snippet: windowSnippet(doc.content, query, snippetWindowTokens),
              path: meta?.path ?? '',
              parentDocId: meta?.parentDocId ?? '',
              meta: toRetrieverMeta(meta),
            };
          }
        }
        // Unhydratable kNN-only hit: keep the rank, emit an empty snippet.
        // (vec0 carries no meta; the Store has no read-by-id; no readDoc
        // wired, OR readDoc returned null because the source doc was
        // deleted/degraded.) Flag so the reported mode reflects the truth.
        knnUnhydrated = true;
        return {
          id: row.id,
          source: asSourceKind(row.source),
          score: row.score,
          snippet: '',
          path: '',
          parentDocId: '',
          meta: {},
        };
      });

      // Mode truthfulness: 'bm25-only' when the kNN leg failed entirely;
      // 'knn' when the kNN leg ran but at least one kNN-only hit couldn't be
      // hydrated (rank delivered, snippet not); 'hybrid' when both legs ran
      // and every hit got a real snippet.
      const mode: SearchMode = knnFailed ? 'bm25-only' : knnUnhydrated ? 'knn' : 'hybrid';
      const degraded = knnFailed || ftsFailed || knnUnhydrated;

      // --- Collapse duplicate parent-docs, then pack to the token budget ---
      const collapsed = collapseByParent(enriched);
      const packed = packBudget(collapsed, budgetTokens);

      return {
        results: packed.hits,
        consumedTokens: packed.consumedTokens,
        truncated: packed.truncated,
        degraded,
        mode,
      };
    },
  };
}
