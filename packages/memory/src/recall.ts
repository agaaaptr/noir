// Hybrid recall pipeline for @noir-ai/memory (slice S7, task t3).
//
// Reuses the S6 hybrid retriever's recipe (DS-5) — BM25 (`Store.searchFt`) ∪
// cosine kNN (`Store.knn`) fused by Reciprocal Rank Fusion (rank-based, k=60,
// weights [0.5, 0.5] — raw BM25+cosine scores are NEVER summed) — scoped to
// `source:'memory'` so context (S6) and memory never collide. Adds a cheap
// regex **entity-boost** (identifiers / file-paths extracted from the query,
// NO LLM — DS-5) that promotes hits whose `content` / `concepts` / `files`
// mention a queried entity.
//
// Pipeline (spec §6):
//   recallMemory(query, opts)
//     ├─ store.searchFt(query, {limit, source:'memory'})        → FtsHit[]  (BM25)
//     ├─ store.knn(await embed(query), {limit, source:'memory'}) → VecHit[]  (kNN)
//     ├─ fuseRrf(bm25, knn, {k:60, weights:[0.5,0.5]})          → RrfResult[] (rank fusion)
//     ├─ entity-boost: extract query entities (regex), add a per-match delta to
//     │    each fused row's score (needs the obs → hydrated first), then re-sort
//     │    by boosted score desc (stable — RRF order preserved on ties).
//     └─ hydrate each fused id into a MemoryHit from the authoritative KV row
//          `memory:obs:<id>` (FULL content — never the truncated FTS snippet,
//          DS-9), applying the optional `type` / `sessionId` filters.
//
// Degradation (mirrors the S6 retriever's F8): if `embed()` throws (the
// embedder is `kind:'none'`, a native load failure, a provider error) OR `knn()`
// itself threw, the kNN leg is skipped and recall degrades to BM25-only — the
// searchFt results are still returned, fused trivially (each with only its BM25
// rank term), and the outcome carries `degraded:true, mode:'bm25-only'`. A BM25
// throw (e.g. a foreign read-only DB missing `docs_fts`) is also caught: recall
// keeps going on the kNN leg when it can, or returns an empty result set rather
// than crashing.
//
// This module owns NO state and opens NO second store connection — it reads
// through the INJECTED handle only (blueprint D6: in-process only, canonical
// ProjectId, capture/store/retrieve always local + free). The engine passes its
// single-writer handle + the SAME `EmbedFn` the daemon already resolved for S6
// (no embedder duplication). `lastAccessTs` is intentionally NOT bumped here:
// recall is a read pipeline, kept side-effect-free + deterministic for tests;
// the field is set at save time and a best-effort bump is a tracked v1.x extra
// (the task marks the bump optional).

import { fuseRrf } from '@noir-ai/context';
import type { FtsHit, Store, VecHit } from '@noir-ai/store';
import { getObservation } from './store.js';
import type { EmbedFn, MemoryHit, Observation, RecallOptions } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Source bucket for every memory row (keeps context + memory disjoint, DS-2). */
const MEMORY_SOURCE = 'memory';

/** Default recall hit cap (mirrors Store.searchFt + the S6 retriever default). */
const DEFAULT_RECALL_LIMIT = 10;

/**
 * Minimum token length to count as an entity. Filters noise from tiny tokens
 * (`ts`, `a`, `an`, `is`) that would otherwise substring-match half the corpus.
 */
const MIN_ENTITY_LEN = 3;

/**
 * Score delta added per DISTINCT query entity an observation matches. RRF
 * scores are tiny (rank-based: max ≈ 2·0.5/(60+1) ≈ 0.016), so a single entity
 * match (0.1) deliberately OUTWEIGHS any rank gap — an explicit identifier /
 * path in the query is a strong intent signal, and a hit that mentions it
 * outranks one that does not. Multiple distinct matches stack. Tunable.
 */
const ENTITY_BOOST_PER_MATCH = 0.1;

/**
 * Common dev-query noise words dropped before matching so they do not inflate
 * the boost (every hit mentioning "the"/"for"/"use" would otherwise tie). Kept
 * small + conservative — only words that carry no retrieval signal.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'your',
  'was',
  'are',
  'can',
  'how',
  'when',
  'what',
  'where',
  'why',
  'who',
  'use',
  'using',
  'used',
  'into',
  'but',
  'not',
  'you',
  'all',
  'any',
  'get',
  'set',
  'put',
  'new',
  'one',
  'two',
  'via',
  'our',
  'its',
  'etc',
]);

// ---------------------------------------------------------------------------
// Dependencies + outcome
// ---------------------------------------------------------------------------

/** The injected store handle + the shared S6 embedder (read-only pipeline). */
export interface RecallDeps {
  /** The daemon's single-writer store handle (may be read-only — reads keep working). */
  store: Store;
  /** Query embedder. A throw on `embed(query)` ⇒ BM25-only degradation. */
  embed: EmbedFn;
}

/** Internal outcome of {@link recallMemory} (the engine projects this to `MemoryHit[]`). */
export interface RecallMemoryResult {
  /** Ranked, hydrated hits (FULL content — DS-9), truncated to `limit`. */
  hits: MemoryHit[];
  /** True when the kNN OR BM25 leg failed this call (honest per-query signal). */
  degraded: boolean;
  /** `'hybrid'` when the kNN leg ran, `'bm25-only'` when it was skipped. */
  mode: 'hybrid' | 'bm25-only';
}

// ---------------------------------------------------------------------------
// Entity extraction (cheap regex, NO LLM — DS-5)
// ---------------------------------------------------------------------------

/**
 * Cheap regex extraction of identifiers + file/path tokens from a query (NO LLM
 * — DS-5). Two kinds of entity are collected, de-duplicated:
 *
 *   1. **Qualified tokens** — whitespace-delimited tokens that contain a `/`,
 *      `.`, or `:` (e.g. `packages/memory/src/recall.ts`, `memory:obs`,
 *      `MemoryEngine.save`). Kept whole + lowercased so they match an
 *      observation's `files` / `concepts` exactly when it mentions the same path
 *      or qualified name.
 *   2. **Identifier subwords** — every token is also split at camelCase /
 *      PascalCase / snake_case / kebab-case boundaries into lowercase subwords
 *      (mirrors the index-side `explodeIdentifiers` convention from
 *      `@noir-ai/context`), so a query for `ContextEngine` yields `context` +
 *      `engine` and a query for `recall_memory` yields `recall` + `memory`.
 *
 * Tokens shorter than {@link MIN_ENTITY_LEN} and {@link STOPWORDS} are dropped
 * to keep matching precise. Pure + deterministic.
 */
export function extractEntities(query: string): string[] {
  const set = new Set<string>();
  const words = query.match(/\S+/g);
  if (words === null) return [];
  for (const token of words) {
    // Qualified (path / dotted / colon) token: keep whole, lowercased, so a
    // full path or qualified name can match an obs `files` entry verbatim.
    if (/[/.:]/.test(token)) {
      const lower = token.toLowerCase();
      if (lower.length >= MIN_ENTITY_LEN) set.add(lower);
    }
    // Explode every token into lowercase identifier subwords.
    for (const piece of splitIdentifier(token)) {
      if (piece.length < MIN_ENTITY_LEN) continue;
      if (STOPWORDS.has(piece)) continue;
      set.add(piece);
    }
  }
  return [...set];
}

/**
 * Split a token into lowercase subwords at camelCase / PascalCase / snake_case /
 * kebab-case boundaries. A focused re-implementation of `@noir-ai/context`'s
 * `explodeIdentifiers` (kept local so the recall path depends on context only
 * for the `fuseRrf` fusion primitive, not the chunker). Pure + deterministic.
 */
function splitIdentifier(token: string): string[] {
  // Alphanumeric runs only; '-' and '_' are left as explicit separators so
  // kebab / snake identifiers split at their boundaries for free.
  const words = token.match(/[A-Za-z0-9]+/g);
  if (words === null) return [];
  const out: string[] = [];
  for (const word of words) {
    const spaced = word
      // lowercase|digit → uppercase:  myVar → my Var | HttpContext → Http Context
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      // uppercase-run → uppercase+lowercase:  XMLHttp → XML Http | HTTPSConn → HTTPS Conn
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    for (const piece of spaced.split(/\s+/)) {
      if (piece.length > 0) out.push(piece.toLowerCase());
    }
  }
  return out;
}

/**
 * Boost for one observation given the extracted query entities: +1 delta per
 * DISTINCT entity that appears in the obs's `content` (case-insensitive
 * substring), `concepts` (exact, case-insensitive), or `files` (case-insensitive
 * substring, so a bare `recall.ts` matches `packages/memory/src/recall.ts`).
 * Each entity contributes at most once (no double-count across fields). Cheap
 * + LLM-free (DS-5).
 */
function entityBoostForObs(obs: Observation, entities: ReadonlyArray<string>): number {
  if (entities.length === 0) return 0;
  const contentLower = obs.content.toLowerCase();
  let matched = 0;
  for (const entity of entities) {
    if (contentLower.includes(entity)) {
      matched += 1;
      continue;
    }
    if (obs.concepts.some((c) => c.toLowerCase() === entity)) {
      matched += 1;
      continue;
    }
    if (obs.files.some((f) => f.toLowerCase().includes(entity))) {
      matched += 1;
    }
  }
  return matched * ENTITY_BOOST_PER_MATCH;
}

// ---------------------------------------------------------------------------
// Hybrid recall
// ---------------------------------------------------------------------------

/**
 * Run hybrid recall (BM25 ∪ kNN → RRF → entity-boost → KV hydration) scoped to
 * `source:'memory'`. Read-only against the injected store; no second connection,
 * no network, no LLM (blueprint D6).
 *
 * The returned hits carry the FULL `content` hydrated from the authoritative KV
 * row (DS-9 — never the truncated FTS snippet). `degraded`/`mode` describe the
 * actual outcome of THIS call: `mode:'bm25-only'` + `degraded:true` when the
 * embedder was unavailable and recall fell back to BM25.
 */
export async function recallMemory(
  deps: RecallDeps,
  query: string,
  opts?: RecallOptions,
): Promise<RecallMemoryResult> {
  const store = deps.store;
  const limit = opts?.limit ?? DEFAULT_RECALL_LIMIT;

  // --- BM25 leg (always attempted; the cheap, always-available signal) ---
  let ftsHits: FtsHit[] = [];
  let ftsFailed = false;
  try {
    ftsHits = store.searchFt(query, { limit, source: MEMORY_SOURCE });
  } catch {
    // e.g. a foreign read-only DB with no `docs_fts` table. Keep going — the
    // vec leg may still return something; flag degraded.
    ftsFailed = true;
  }

  // --- kNN leg (attempted; any failure ⇒ BM25-only degradation, F8-style) ---
  let knnHits: VecHit[] = [];
  let knnFailed = false;
  try {
    const qvec = await deps.embed(query); // throws on kind:'none' / load / provider error
    try {
      knnHits = store.knn(qvec, { limit, source: MEMORY_SOURCE });
    } catch {
      // vec0 table missing or query malformed — degrade to BM25-only.
      knnFailed = true;
    }
  } catch {
    // embed() threw: the embedder is unavailable. BM25-only (F8).
    knnFailed = true;
  }

  const mode: 'hybrid' | 'bm25-only' = knnFailed ? 'bm25-only' : 'hybrid';
  const degraded = knnFailed || ftsFailed;

  // --- RRF fusion (rank-based; raw BM25+cosine scores NEVER summed) ---
  const fused = fuseRrf(ftsHits, knnHits);

  // --- Hydrate + filter + entity-boost, then stable re-sort by boosted score ---
  const entities = extractEntities(query);
  const hits: MemoryHit[] = [];
  for (const row of fused) {
    const obs = getObservation(store, row.id);
    // A fused id with no KV row is a stale vec-only hit whose row was forgotten
    // — never emit it with partial data (mirrors the engine's hydrateHits).
    if (obs === null) continue;
    if (opts?.type !== undefined && obs.type !== opts.type) continue;
    if (opts?.sessionId !== undefined && obs.sessionId !== opts.sessionId) continue;
    hits.push(toMemoryHit(obs, row.score + entityBoostForObs(obs, entities)));
  }

  // Stable sort by boosted score desc. Node's Array.prototype.sort is stable
  // (V8 ≥ 7.0), so equal scores preserve insertion order — which is fuseRrf's
  // own deterministic order (score desc → best rank → first-seen). Truncate to
  // `limit` AFTER the sort so a boosted hit can leapfrog into the top window.
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), degraded, mode };
}

// ---------------------------------------------------------------------------
// Small pure helpers (module-local)
// ---------------------------------------------------------------------------

/**
 * Project an {@link Observation} into a {@link MemoryHit} at a given (already
 * boosted) score. Carries the FULL `content` (DS-9). Mirrors the engine's
 * private `toMemoryHit` shape exactly so recall + search hits read the same.
 */
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
