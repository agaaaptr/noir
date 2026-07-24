// Local in-process embedder: `@huggingface/transformers` + all-MiniLM-L6-v2.
//
// DESIGN (spec DS-2 / NFR-4):
//   - The `@huggingface/transformers` module is imported LAZILY via dynamic
//     `import()` on the FIRST `embed()` call, never at module top level. This
//     keeps CLI startup and every non-context code path offline and fast, and
//     means a missing/broken `onnxruntime-node` native binary degrades to
//     BM25-only at runtime instead of crashing import (F8).
//   - The ONNX pipeline is created once and memoized for the process lifetime
//     (the daemon owns a single ContextEngine → one pipeline per serve cycle).
//     A failed load resets the memo so the next call can retry (e.g. after a
//     transient first-run download failure).
//   - Model weights cache is pinned to `~/.noir/models/` (HOME-relative — keeps
//     the project `.noir/` dir portable across machines; spec OQ-7 resolved),
//     centralized as `modelsDir()` in @noir-ai/core (task t10). The local
//     `MODELS_DIR` const re-exports that value so this module's existing
//     imports keep resolving to the identical path.
//   - Output is mean-pooled then L2-normalized through the shared `l2normalize`
//     so every provider path funnels through one normalization (DS-8).

import { mkdirSync } from 'node:fs';
import { modelsDir } from '@noir-ai/core';
import type { EmbedFn } from '../types.js';
import { EMBED_DIM, l2normalize } from './normalize.js';

/** Default HF repo id — 384-dim, matches the vec0 table with zero migration. */
export const DEFAULT_LOCAL_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * `~/.noir/models/` — user-global cache for downloaded ONNX weights.
 * HOME-relative (NOT project `.noir/`) so projects stay portable. Centralized
 * via `@noir-ai/core`'s `modelsDir()`; re-exported here so existing imports of
 * `MODELS_DIR` keep resolving to the same path.
 */
export const MODELS_DIR = modelsDir();

// Minimal structural view of the transformers.js v3 module surface this file
// touches. Declared locally (rather than importing the package's deep types) so
// the dynamic import stays version-robust and the package builds even when the
// optional native runtime is absent from the install.
interface HFTransformers {
  readonly env: { cacheDir?: string };
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options?: { quantized?: boolean },
  ) => Promise<FeatureExtractionPipeline>;
}

type FeatureExtractionPipeline = (
  texts: string,
  options?: { pooling?: 'mean' | 'cls' | 'none'; normalize?: boolean },
) => Promise<{ data: ArrayLike<number>; dims: number[] }>;

/** Result of a lazy load: a per-text embedder backed by a cached pipeline. */
type LoadedEmbedder = (text: string) => Promise<Float32Array>;

// Memoized load promises, keyed by model id. One in-flight load per model
// (the daemon is the single writer / one ContextEngine per serve lifecycle,
// so typically a single entry; keying by model avoids a silent collision if
// two different models are ever constructed in the same process). A failed
// load evicts its own entry so the next call may retry.
const pipelineCache = new Map<string, Promise<LoadedEmbedder>>();

async function loadPipeline(model: string): Promise<LoadedEmbedder> {
  try {
    const mod = (await import('@huggingface/transformers')) as unknown as HFTransformers;
    // Pin the download cache before constructing the pipeline.
    mkdirSync(MODELS_DIR, { recursive: true });
    mod.env.cacheDir = MODELS_DIR;
    const extractor = await mod.pipeline('feature-extraction', model);
    return async (text: string): Promise<Float32Array> => {
      // mean-pool the token embeddings; `l2normalize` (not normalize:true) is
      // the single normalization every provider funnels through (DS-8).
      const out = await extractor(text, { pooling: 'mean' });
      // transformers.js `Tensor.data` is a typed array; copy into a fresh
      // Float32Array of exactly the model's embedding width.
      const dim = out.dims.at(-1) ?? EMBED_DIM;
      const raw = new Float32Array(dim);
      for (let i = 0; i < dim; i++) raw[i] = out.data[i] ?? 0;
      return l2normalize(raw);
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `local embedder: failed to load model "${model}" (is @huggingface/transformers installed and the onnxruntime native binary present?): ${reason}`,
    );
  }
}

/** Lazily resolve (and memoize) the cached embedder, resetting on failure. */
function getEmbedder(model: string): Promise<LoadedEmbedder> {
  const cached = pipelineCache.get(model);
  if (cached) return cached;
  // Evict this model's entry on rejection so the next call may retry;
  // concurrent callers share the single in-flight load promise for that model.
  const promise = loadPipeline(model).catch((e) => {
    pipelineCache.delete(model);
    throw e;
  });
  pipelineCache.set(model, promise);
  return promise;
}

export interface LocalEmbedderOptions {
  /** HF repo id (defaults to {@link DEFAULT_LOCAL_MODEL}). */
  model?: string;
}

export interface LocalEmbedder {
  /** Embed function — loads the model lazily on first invocation. */
  embed: EmbedFn;
  /** Resolved model id. */
  model: string;
}

/**
 * Build a local in-process embedder. Construction is synchronous and never
 * touches the network or the native runtime — the dynamic `import()` happens
 * inside `embed()`, so `localEmbedder()` is safe to call at startup. Load
 * failures surface as rejections from `embed()`; callers (retriever/engine)
 * catch them and degrade to BM25-only (F8).
 */
export function localEmbedder(opts: LocalEmbedderOptions = {}): LocalEmbedder {
  const model = opts.model ?? DEFAULT_LOCAL_MODEL;
  return {
    model,
    embed: async (text: string): Promise<Float32Array> => {
      const run = await getEmbedder(model);
      return run(text);
    },
  };
}
