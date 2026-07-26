// Context-local types for @noir-ai/context (slice S6).
//
// These are the package's OWN interfaces — the storage surface (`Store`,
// `EmbedFn`, `IndexDoc`, `FtsHit`, `VecHit`) is re-exported from
// @noir-ai/store below, and the user-facing zod schema lives in @noir-ai/core
// (`NoirConfigSchema.context`). There is deliberately NO zod here: core owns
// the user schema and context owns this factory/engine type surface, which
// keeps the dependency graph acyclic (core never imports context).
//
// Conventions mirror @noir-ai/store types (JSDoc on every interface/field)
// and @noir-ai/workflow types (`as const` source tables → derived unions).

// ---------------------------------------------------------------------------
// Source taxonomy
// ---------------------------------------------------------------------------

/**
 * Logical source buckets a chunk can belong to. Reused for memory —
 * `'memory'` is reserved for that slice. The store treats `source` as a
 * free-form string; this enum is the context package's contract for what a
 * well-formed `source` value is.
 */
export const SOURCES = ['codebase', 'docs', 'spec', 'memory'] as const;
export type SourceKind = (typeof SOURCES)[number];

// ---------------------------------------------------------------------------
// Embedder configuration + info
// ---------------------------------------------------------------------------

/** Discriminant for {@link EmbedderConfig}. */
export type EmbedderKind = 'local' | 'remote' | 'ollama' | 'none';

/**
 * Local in-process embeddings via `@huggingface/transformers`
 * (default `Xenova/all-MiniLM-L6-v2`, 384-dim → zero vec0 migration).
 * The model is loaded lazily on first `embed()` call, never at import time.
 */
export interface LocalEmbedderConfig {
  kind: 'local';
  /** HF repo id (defaults to `Xenova/all-MiniLM-L6-v2` in the factory). */
  model?: string;
}

/**
 * Opt-in remote embeddings (OpenAI / Voyage / Cohere). Provider-explicit:
 * sends source text to a cloud endpoint. Vectors are L2-normalized and
 * Matryoshka-truncated to `dim` client-side to stay vec0-compatible.
 * NEVER the default (blueprint D6 — no silent paid calls).
 */
export interface RemoteEmbedderConfig {
  kind: 'remote';
  /** Provider key, e.g. `'openai'` | `'voyage'` | `'cohere'`. */
  provider: string;
  /** API key. If absent the factory throws a clear "not configured" error. */
  apiKey?: string;
  /** Provider-specific model id. */
  model: string;
  /** Target dimensionality (must be 384 to match the vec0 table). */
  dim: number;
}

/**
 * Opt-in Ollama embeddings via a user-supplied base URL. Provider-explicit;
 * never the default.
 */
export interface OllamaEmbedderConfig {
  kind: 'ollama';
  /** Base URL of the Ollama server, e.g. `http://localhost:11434`. */
  baseURL: string;
  /** Ollama model tag. */
  model: string;
}

/**
 * Escape hatch: disable vectors entirely. `search` degrades to BM25-only
 * (`degraded:true, mode:'bm25-only'`).
 */
export interface NoneEmbedderConfig {
  kind: 'none';
}

/**
 * Discriminated configuration for the embedder factory (`createEmbedFn`,
 * task t3). The core zod schema maps onto this via `resolveEmbedderConfig`
 * (task t10) — that mapper is the only bridge between the two layers.
 */
export type EmbedderConfig =
  | LocalEmbedderConfig
  | RemoteEmbedderConfig
  | OllamaEmbedderConfig
  | NoneEmbedderConfig;

/**
 * Description of the active embedder, surfaced by `context_status` and
 * recorded in store KV (`ctx:embedder`) so a model swap is detectable.
 * For `kind:'none'`, `dim` is `0` and `model` is `undefined`.
 */
export interface EmbedderInfo {
  kind: EmbedderKind;
  model?: string;
  dim: number;
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

/** Metadata attached to every chunk (stored as `docs.meta` / `vec.meta`). */
export interface ChunkMeta {
  /** Repo-relative or absolute path of the source file. */
  path: string;
  /**
   * `sha256(path)` — stable parent-document id. The budget packer collapses
   * duplicate parent-docs on this field so one file can't flood the results.
   */
  parentDocId: string;
  /** 0-based position of this chunk within its parent file. */
  chunkIndex: number;
  /** Detected language / extension hint (e.g. `'typescript'`, `'markdown'`). */
  language: string;
  /** SHA-256 of this chunk's (post-identifier-explosion) content. */
  sha256: string;
}

/**
 * A unit of indexed content. One chunk → one `docs` row (FTS-synced) AND one
 * `vec0` row under the SAME `id`, so RRF can join BM25 and kNN hits.
 * `id` is `<sha256(path)>#chunk-<n>` (stable across re-indexing).
 */
export interface Chunk {
  id: string;
  source: SourceKind;
  content: string;
  meta: ChunkMeta;
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** Pair of non-negative weights `[bm25Weight, kNNWeight]`; defaults `[0.5, 0.5]`. */
export type RRFWeights = [number, number];

/**
 * Retrieval mode actually used for a `search` call.
 * - `'hybrid'` — BM25 ∪ kNN fused by RRF, AND every kNN-only hit was hydrated
 *   to a real windowed snippet (the ideal outcome).
 * - `'knn'` — the kNN leg ran but at least one kNN-only hit could NOT be
 *   hydrated (no `readDoc` hydrator, or the source doc was deleted/degraded),
 *   so that hit keeps its rank but carries an empty snippet. Honest about the
 *   fact the caller did not receive the full hybrid snippet quality.
 * - `'bm25-only'` — degraded fallback when the embedder is unavailable
 *   (`kind:'none'` or `embed()` threw); the kNN leg did not run at all.
 */
export type SearchMode = 'hybrid' | 'knn' | 'bm25-only';

/**
 * Secondary metadata carried on a retriever hit. All optional: a BM25 hit
 * reaches the retriever already enriched, while a kNN-only hit may only
 * carry `id` + `source` until the retriever backfills the rest. The primary
 * `path` / `parentDocId` fields live top-level on {@link RetrieverHit}
 * (spec F6); this holds the remaining enrichment.
 */
export interface RetrieverMeta {
  language?: string;
  sha256?: string;
  chunkIndex?: number;
}

/**
 * A single ranked result. `snippet` is FTS5 window-extracted
 * (`snippet(docs_fts,0,'<<','>>','…',16)`) for BM25 hits, or a window around
 * the chunk's first N tokens for kNN-only hits — never truncated mid-token.
 *
 * `path` and `parentDocId` are top-level (spec F6 enumerates the item as
 * `{id, source, score, snippet, path, parentDocId}`): the retriever
 * backfills them from the chunk's `meta` before the hit leaves `search()`,
 * so they are always present at the public/MCP boundary.
 */
export interface RetrieverHit {
  id: string;
  source: SourceKind;
  /** RRF-fused rank score (rank-based; not a normalized similarity). */
  score: number;
  snippet: string;
  /** Repo-relative or absolute path of the source file (backfilled from meta). */
  path: string;
  /** `sha256(path)` — stable parent-document id (backfilled from meta). */
  parentDocId: string;
  /** Secondary enrichment (language, sha256, chunkIndex). */
  meta: RetrieverMeta;
}

/**
 * Return value of `search`. `results` is packed greedily into `budgetTokens`
 * (default ~4k): when the budget is exhausted before the ranked list,
 * `truncated` is `true` and `consumedTokens` ~= `budgetTokens`.
 */
export interface SearchResult {
  results: RetrieverHit[];
  /** Tokens accumulated across the returned snippets. */
  consumedTokens: number;
  /** `true` if the budget was hit before exhausting the ranked list. */
  truncated: boolean;
  /** `true` when the embedder was unavailable (BM25-only fallback, F8). */
  degraded: boolean;
  /** Retrieval mode actually used. */
  mode: SearchMode;
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Return value of `indexPaths`. Counts are mutually consistent: a chunk is
 * either newly `indexed`, `skipped` (content-hash unchanged in KV), or part
 * of a `deleted`/`failed` file. `totalChunks` is the running total tracked
 * for the indexed paths after this call. `degraded` mirrors the search path
 * (spec F10: `context_index -> {indexed, skipped, deleted, degraded}`).
 */
export interface IndexResult {
  /** Chunks newly written to `docs` + `vec0` this run. */
  indexed: number;
  /** Chunks whose SHA-256 matched KV (unchanged since last index). */
  skipped: number;
  /** Files removed since last index — their chunks + vectors were deleted. */
  deleted: number;
  /**
   * True when the embedder was unavailable this run (docs indexed without
   * vectors). Mirrors SearchResult.degraded / StoreStatus.degraded.
   */
  degraded: boolean;
  /** Files that could not be read/parsed (binary, IO error, encoding). */
  failed: number;
  /** Total chunks now tracked for the indexed paths. */
  totalChunks: number;
}

// ---------------------------------------------------------------------------
// Re-exports (single import surface for the rest of the package)
// ---------------------------------------------------------------------------

// Canonical project identifier (NEVER a filesystem path — blueprint D6).
export type { ProjectId } from '@noir-ai/core';
// The storage seam S6 builds on. Re-exported here so context modules import
// from `../types.js` (or the barrel) rather than reaching into @noir-ai/store
// directly for the handful of primitives they need.
export type {
  EmbedFn,
  FtsHit,
  IndexDoc,
  Store,
  VecHit,
} from '@noir-ai/store';
