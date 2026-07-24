// ContextEngine for @noir-ai/context (slice S6, task t8).
//
// The single object that ties the embedder, indexer, and retriever together and
// that the daemon injects as `ctx.context` — the new optional ServerContext
// service, mirroring `ctx.store` / `ctx.engine`. It is constructed ONCE per
// serve lifecycle from the daemon's already-open Store handle (the single
// writer — blueprint D6: in-process, no sidecar, canonical ProjectId) and a
// resolved EmbedderConfig, exactly as `buildWorkflowEngine` is built once from
// the same handle.
//
// Responsibilities:
//   • resolve the embedder once (`createEmbedFn`) and share it between the
//     indexer (writes vectors) and the retriever (embeds the query), so a lazy
//     local model loads at most once per lifecycle;
//   • own the indexer + retriever, delegating `indexPaths` / `search` to them;
//   • surface a `status()` snapshot (spec F11) that mirrors `buildStoreStatus`
//     and adds the embedder description + the indexed-file count.
//
// Single-writer discipline: the engine — through its indexer — is the ONLY
// thing that calls `indexDoc`/`upsertVec` for context. The retriever is purely
// read-only. Both reuse the injected handle; the engine never opens a second
// store connection.
//
// Degradation (mirrors the store's degraded story, spec F8/F12):
//   • engine-level `degraded` = the store handle is read-only (the daemon-down
//     fallback) OR the embedder is disabled (`kind:'none'`). It is a PERSISTENT
//     flag reported by `status()`.
//   • per-call `degraded` (on SearchResult) is computed by the retriever for
//     each query (true when the kNN leg failed THAT call). The two are
//     independent and both honest: `status()` describes the configured state;
//     `search()` describes the actual outcome.
//
// kNN-only hydration (spec F7): the Store interface exposes no read-by-id and
// vec0 carries no meta column, so a purely-semantic hit (kNN-only, no BM25
// snippet) cannot be windowed without a content source. v1 intentionally does
// NOT wire a `readDoc` hydrator: BM25 hits — the common, lexical path — always
// carry their FTS5 windowed snippet verbatim (never truncated), and a kNN-only
// hit degrades to an empty snippet while keeping its rank (the retriever's
// tested fallback). A future `Store.getDoc` would let the engine hydrate these
// with no other change here.

import { createEmbedFn } from './embedders/index.js';
import { CTX_REGISTRY_KEY, createIndexer, type Indexer, type IndexPathOptions } from './indexer.js';
import { createRetriever, type Retriever, type SearchOptions } from './retriever.js';
import type {
  EmbedderConfig,
  EmbedderInfo,
  IndexResult,
  ProjectId,
  SearchResult,
  Store,
} from './types.js';

// ---------------------------------------------------------------------------
// Status payload (mirrors StoreStatus in @noir-ai/daemon server.ts)
// ---------------------------------------------------------------------------

/**
 * JSON returned by the `context_status` MCP tool (spec F11). Mirrors
 * `StoreStatus` and adds the active embedder description + the indexed-file
 * count (the size of the `ctx:registry` KV list the indexer maintains).
 */
export interface ContextStatus {
  ok: boolean;
  /** Canonical project id (never a filesystem path — blueprint D6). */
  projectId: string;
  /** Rows in `docs` (live read off the single writer handle — no cache). */
  docCount: number;
  /** Rows in `vec0` (live read off the single writer handle — no cache). */
  vecCount: number;
  /** Number of files currently tracked in `ctx:registry`. */
  indexedFiles: number;
  /** Active embedder description (`kind:'none'` ⇒ `{kind:'none', dim:0}`). */
  embedder: EmbedderInfo;
  /**
   * Persistent degradation flag: the store handle is read-only OR the embedder
   * is disabled (`kind:'none'`). Per-query degradation lives on SearchResult.
   */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Construction options
// ---------------------------------------------------------------------------

/** Construction options for {@link ContextEngine}. */
export interface ContextEngineOptions {
  /**
   * The daemon's store handle — the ONLY storage surface used (single writer).
   * May be a read-only fallback handle; pass {@link storeDegraded} so `status()`
   * can report it.
   */
  store: Store;
  /**
   * Project root. Paths passed to {@link ContextEngine.indexPaths} resolve
   * against it and (because the indexer is root-bound) are stored repo-relative
   * for portable `meta.path` across checkouts.
   */
  root: string;
  /** Canonical project identifier (NEVER a filesystem path). */
  projectId: ProjectId;
  /**
   * Resolved embedder config (from `resolveEmbedderConfig`). Construction never
   * touches the network or native runtime — even `local` defers its dynamic
   * import to the first `embed()` call.
   */
  embedderCfg: EmbedderConfig;
  /**
   * True when `store` was opened read-only (the daemon-down fallback). Threads
   * the store's degraded story into the engine's persistent `degraded` flag so
   * `status()` reports it and callers can branch on it.
   */
  storeDegraded?: boolean;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/**
 * Noir's embedded hybrid retrieval engine — the `ctx.context` service.
 *
 * Constructed once per serve lifecycle (mirror `buildWorkflowEngine`) from the
 * daemon's store handle + a resolved {@link EmbedderConfig}. Resolves the
 * embedder, then owns the indexer (the only context writer) and the retriever
 * (the only context reader). Public surface: {@link indexPaths}, {@link search},
 * {@link status} — the three operations the `context_{index,search,status}` MCP
 * tools (task t9) delegate to.
 */
export class ContextEngine {
  /** The daemon's single-writer store handle (possibly read-only). */
  readonly store: Store;
  /** Project root (paths resolve against this). */
  readonly root: string;
  /** Canonical project identifier. */
  readonly projectId: ProjectId;
  /** Description of the active embedder (surfaced by `status()`). */
  readonly embedder: EmbedderInfo;
  /**
   * Persistent degradation flag (read-only store OR `kind:'none'`). Per-query
   * degradation lives on {@link SearchResult}.
   */
  readonly degraded: boolean;

  private readonly indexer: Indexer;
  private readonly retriever: Retriever;

  constructor(opts: ContextEngineOptions) {
    this.store = opts.store;
    this.root = opts.root;
    this.projectId = opts.projectId;

    // Resolve the embedder ONCE; share it between the indexer (writes vectors)
    // and the retriever (embeds the query) so a lazy local model loads at most
    // once per serve lifecycle (the daemon owns a single ContextEngine).
    const { embed, info } = createEmbedFn(opts.embedderCfg);
    this.embedder = info;

    // Persistent degradation: read-only store OR vectors explicitly disabled.
    // (A misconfigured remote/ollama embedder is NOT degraded here — it builds
    // cleanly and surfaces its failure per-call via SearchResult.degraded, F8.)
    this.degraded = opts.storeDegraded === true || info.kind === 'none';

    // Both reuse the SAME injected handle — the engine never opens a second
    // connection (single writer). The indexer is root-bound so path keys are
    // repo-relative; the retriever is read-only and uses the retriever defaults
    // (RRF k=60 / [0.5,0.5], budget 4096, no kNN-only readDoc hydrator in v1).
    this.indexer = createIndexer({ store: opts.store, embed, info, root: opts.root });
    this.retriever = createRetriever({ store: opts.store, embed });
  }

  /**
   * Incrementally index `paths` (files or directories) into the store. Delegates
   * to the indexer (spec F1/F3/F4). The engine — through the indexer — is the
   * ONLY context writer; the daemon stays the single writer via this handle.
   */
  indexPaths(paths: string[], opts?: IndexPathOptions): Promise<IndexResult> {
    return this.indexer.indexPaths(paths, opts);
  }

  /**
   * Hybrid search: BM25 ∪ cosine-kNN fused by RRF (k=60), collapsed by
   * parent-doc, packed to a token budget with window-extracted snippets (spec
   * F6/F7). Delegates to the retriever. The per-call `degraded`/`mode` on the
   * returned {@link SearchResult} reflect THIS query's outcome (independent of
   * the engine's persistent {@link degraded}).
   */
  search(query: string, opts?: SearchOptions): Promise<SearchResult> {
    return this.retriever.search(query, opts);
  }

  /**
   * Snapshot the engine's state (spec F11; mirrors `buildStoreStatus`).
   *
   * `docCount`/`vecCount` are live reads off the single writer handle (no
   * cache); `indexedFiles` is the size of the `ctx:registry` KV list maintained
   * by the indexer; `embedder` describes the active provider; `degraded` is the
   * persistent flag (read-only store OR `kind:'none'`).
   */
  status(): ContextStatus {
    const registry = this.store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    return {
      ok: true,
      projectId: this.store.projectId,
      docCount: this.store.countDocs(),
      vecCount: this.store.countVecs(),
      indexedFiles: registry.length,
      embedder: this.embedder,
      degraded: this.degraded,
    };
  }
}
