// @noir-ai/context — Noir's embedded hybrid retrieval engine (slice S6).
//
// Fills the `EmbedFn` seam declared (but never implemented) by @noir-ai/store:
// local embeddings (@huggingface/transformers + all-MiniLM-L6-v2, 384-dim),
// SHA-256 content-hash incremental indexing into the existing docs + vec0
// tables (no schema migration), and BM25 ∪ cosine-kNN retrieval fused by
// Reciprocal Rank Fusion (k=60, rank-based) into a token-budget packer with
// window-extracted snippets (never truncated).
//
// Public surface (spec §15 Definition of Done): the ContextEngine (the
// `ctx.context` service), the embedder factory + provider implementations, the
// chunker, the indexer, the RRF fusion, the retriever, the config mapper, and
// the shared types. The store/core primitives (`EmbedFn`, `Store`, `ProjectId`…)
// are re-exported for a single import surface.

// --- Chunker (markdown-heading | line/token windows; identifier explosion) ---
export {
  type ChunkOptions,
  chunkFile,
  DEFAULT_CHUNK_MAX_TOKENS,
  DEFAULT_CHUNK_OVERLAP,
  estimateTokens,
  explodeIdentifiers,
  inferLanguage,
  TOKEN_ESTIMATE_FACTOR,
  withIdentifierExplosion,
} from './chunker.js';

// --- Config mapper (core user schema → factory input; avoids core→context cycle) ---
export { type ContextUserConfig, resolveEmbedderConfig } from './config.js';
// --- Engine (the ctx.context service; constructed once per serve lifecycle) ---
export { ContextEngine, type ContextEngineOptions, type ContextStatus } from './contextEngine.js';
// --- Semantic duplicate detection (cosine over embedded file contents) ---
export {
  DEFAULT_DUP_THRESHOLD,
  type DupCandidate,
  type DupPair,
  findNearestDuplicate,
  findSemanticDuplicates,
  NEAREST_DUP_DEFAULT_THRESHOLD,
} from './dedup.js';
// --- Embedders (the EmbedFn seam) ---
export {
  createEmbedFn,
  DEFAULT_LOCAL_MODEL,
  EMBED_DIM,
  fakeEmbedFn,
  type LocalEmbedder,
  type LocalEmbedderOptions,
  l2normalize,
  localEmbedder,
  MODELS_DIR,
  type OllamaEmbedderOptions,
  ollamaEmbedder,
  type RemoteEmbedderOptions,
  type ResolvedEmbedder,
  remoteEmbedder,
} from './embedders/index.js';
// --- Indexer (content-hash incremental; the ONLY context writer) ---
export {
  CTX_EMBEDDER_KEY,
  CTX_FILE_PREFIX,
  CTX_REGISTRY_KEY,
  createIndexer,
  ctxFileKey,
  type FileRecord,
  type ForgetResult,
  type Indexer,
  type IndexerOptions,
  type IndexPathOptions,
  isBinaryExt,
  isSensitive,
  SKIP_DIRS,
} from './indexer.js';
// --- Retriever (hybrid search: BM25 ∪ kNN → RRF → budget → snippets) ---
export {
  type ChunkDoc,
  createRetriever,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_SEARCH_LIMIT,
  DEFAULT_SNIPPET_WINDOW_TOKENS,
  type Retriever,
  type RetrieverDeps,
  type RetrieverOptions,
  type SearchOptions,
  windowSnippet,
} from './retriever.js';
// --- RRF fusion (rank-based; k=60, weights [0.5,0.5]; never sums raw scores) ---
export {
  DEFAULT_RRF_K,
  DEFAULT_RRF_WEIGHTS,
  type FuseRrfOptions,
  fuseRrf,
  type RrfResult,
} from './rrf.js';
// --- Store / core primitives re-exported for a single import surface ---
export type {
  Chunk,
  ChunkMeta,
  EmbedderConfig,
  EmbedderInfo,
  EmbedderKind,
  EmbedFn,
  FtsHit,
  IndexDoc,
  IndexResult,
  LocalEmbedderConfig,
  NoneEmbedderConfig,
  OllamaEmbedderConfig,
  ProjectId,
  RemoteEmbedderConfig,
  RetrieverHit,
  RetrieverMeta,
  RRFWeights,
  SearchMode,
  SearchResult,
  SourceKind,
  Store,
  VecHit,
} from './types.js';
// --- Types (package-local contracts) ---
export { SOURCES } from './types.js';
