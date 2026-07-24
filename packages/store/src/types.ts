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

export interface Store {
  readonly projectId: ProjectId;
  getState<T>(key: string): T | null;
  setState<T>(key: string, value: T): void;
  /** Upsert a document into the `docs` table (FTS sync is automatic via triggers). */
  indexDoc(doc: IndexDoc): void;
  /** BM25 full-text search with window-extracted snippets. */
  searchFt(query: string, opts?: SearchFtOpts): FtsHit[];
  close(): Promise<void>;
}
