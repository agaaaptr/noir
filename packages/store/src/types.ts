import type { ProjectId } from '@noir-ai/core';

export interface OpenOptions {
  projectId: ProjectId;
  root: string;
  readonly?: boolean;
}

export interface FtsHit {
  id: string;
  source: string;
  score: number;
  snippet: string;
  meta?: unknown;
}

export interface VecHit {
  id: string;
  source: string;
  score: number;
  meta?: unknown;
}

export type EmbedFn = (text: string) => Promise<Float32Array>;

/** Input to {@link Store.indexDoc}: an upsertable document. */
export interface IndexDoc {
  id: string;
  source: string;
  content: string;
  meta?: unknown;
}

/** Optional filters/cap for {@link Store.searchFt}. */
export interface SearchFtOpts {
  /** Maximum number of hits to return (default 10). */
  limit?: number;
  /** Restrict results to a single source. */
  source?: string;
}

/** Metadata accepted by {@link Store.upsertVec}. */
export interface VecUpsertMeta {
  /** Logical source bucket for the vector (default `'default'`). */
  source?: string;
}

/** Optional filters/cap for {@link Store.knn}. */
export interface VecOpts {
  /** Maximum number of neighbors to return (default 5). */
  limit?: number;
  /** Restrict results to a single source bucket (applied at kNN scan time). */
  source?: string;
}

export interface Store {
  readonly projectId: ProjectId;
  getState<T>(key: string): T | null;
  setState<T>(key: string, value: T): void;
  /** Upsert a document into the `docs` table (FTS sync is automatic via triggers). */
  indexDoc(doc: IndexDoc): void;
  /** BM25 full-text search with window-extracted snippets. */
  searchFt(query: string, opts?: SearchFtOpts): FtsHit[];
  /** Upsert a 384-dim vector keyed by `id` (idempotent; delete-by-id-then-insert). */
  upsertVec(id: string, vec: Float32Array, meta?: VecUpsertMeta): void;
  /** k-nearest-neighbor search over `vec`; results ordered by ascending distance. */
  knn(vec: Float32Array, opts?: VecOpts): VecHit[];
  /** Count rows in the `docs` table (live read from the single writer handle). */
  countDocs(): number;
  /** Count rows in the `vec` table (live read from the single writer handle). */
  countVecs(): number;
  /** Export all `docs` rows to `<dir>/<id>.md` with YAML frontmatter. */
  exportMarkdown(dir: string): Promise<string[]>;
  close(): Promise<void>;
}
