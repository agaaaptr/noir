// Embedder factory + provider implementations for @noir-ai/context.
//
// Every implementation returns an L2-normalized `EMBED_DIM`-wide
// `Float32Array` via the shared `l2normalize`, fulfilling the `EmbedFn` seam
// declared by @noir-ai/store but never implemented there. `createEmbedFn` is the
// single factory the engine calls; it dispatches on the `EmbedderConfig`
// discriminated union (from ../types) and returns `{ embed, info }`.
//
// Provider matrix:
//   local    — @huggingface/transformers + all-MiniLM-L6-v2 (DEFAULT; lazy load)
//   remote   — OpenAI / Voyage / Cohere (OPT-IN, provider-explicit, paid)
//   ollama   — local Ollama server (OPT-IN, provider-explicit)
//   none     — disable vectors; search degrades to BM25-only (F8)

import type { EmbedderConfig, EmbedderInfo, EmbedFn } from '../types.js';
import { localEmbedder } from './local.js';
import { EMBED_DIM } from './normalize.js';
import { ollamaEmbedder } from './ollama.js';
import { remoteEmbedder } from './remote.js';

/** Result of resolving an embedder config: a callable + describing metadata. */
export interface ResolvedEmbedder {
  /** The `EmbedFn` the engine/retriever/indexer call. May throw on load/config failure. */
  embed: EmbedFn;
  /** Surfaced by `context_status` and recorded in store KV (`ctx:embedder`). */
  info: EmbedderInfo;
}

/**
 * Build an `{ embed, info }` pair from a config. Construction never touches the
 * network or the native runtime — even `local` defers its dynamic import to the
 * first `embed()` call. `kind:'none'` (and any load failure the caller lets
 * propagate) yields BM25-only retrieval downstream (F8).
 */
export function createEmbedFn(cfg: EmbedderConfig): ResolvedEmbedder {
  switch (cfg.kind) {
    case 'local': {
      const { embed, model } = localEmbedder({ model: cfg.model });
      return { embed, info: { kind: 'local', model, dim: EMBED_DIM } };
    }
    case 'remote': {
      const embed = remoteEmbedder({
        provider: cfg.provider,
        apiKey: cfg.apiKey,
        model: cfg.model,
        dim: cfg.dim,
      });
      return { embed, info: { kind: 'remote', model: cfg.model, dim: cfg.dim } };
    }
    case 'ollama': {
      const embed = ollamaEmbedder({ baseURL: cfg.baseURL, model: cfg.model });
      return { embed, info: { kind: 'ollama', model: cfg.model, dim: EMBED_DIM } };
    }
    case 'none': {
      // Defer the error to embed() — but the retriever branches on
      // info.kind === 'none' first, so this stub never runs in the normal path.
      const embed: EmbedFn = async () => {
        throw new Error('embedder disabled (kind:"none"); search degrades to BM25-only');
      };
      return { embed, info: { kind: 'none', dim: 0 } };
    }
  }
}

// `fakeEmbedFn` (./fake.js) is a TEST-ONLY deterministic double (SHA-256-seeded
// 384-dim vectors). It is exported here so cross-package test suites (memory
// consumes it too) share ONE definition — but it is NOT used by any production
// path: `kind:'none'` deliberately throws its own stub rather than returning a
// fake vector. Treat it as a test fixture, never as production surface.
export { fakeEmbedFn } from './fake.js';
export type { LocalEmbedder, LocalEmbedderOptions } from './local.js';
export { DEFAULT_LOCAL_MODEL, localEmbedder, MODELS_DIR } from './local.js';
// Re-export the building blocks so the engine, tests, and t10's
// `resolveEmbedderConfig` mapper can import everything from one path.
export { EMBED_DIM, l2normalize } from './normalize.js';
export type { OllamaEmbedderOptions } from './ollama.js';
export { ollamaEmbedder } from './ollama.js';
export type { RemoteEmbedderOptions } from './remote.js';
export { remoteEmbedder } from './remote.js';
