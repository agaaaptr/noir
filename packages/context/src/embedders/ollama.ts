// Opt-in OLLAMA embeddings (local Ollama server).
//
// DESIGN (spec DS-2 / blueprint D6):
//   - Provider-explicit and NEVER the default. The caller selects `kind:'ollama'`
//     with a concrete `baseURL`; the blueprint rejects an always-on Ollama
//     sidecar, so this is the supported opt-in path for users who already run
//     Ollama locally.
//   - Like the remote embedder, a missing `baseURL` throws a clear "not
//     configured" error from `embed()` (not at construction) so the engine can
//     report status and degrade to BM25-only (F8).
//   - Ollama's `/api/embeddings` returns the model's native-width vector; we
//     Matryoshka-truncate to `EMBED_DIM` (384) and re-normalize via the shared
//     `l2normalize`. A vector shorter than 384 is a hard config error (the user
//     must pick a >= 384-dim Ollama model such as `nomic-embed-text`).
//
// Thin stub: direct `fetch`, no retry/batching (post-v0, plan §7).

import type { EmbedFn } from '../types.js';
import { EMBED_DIM, l2normalize } from './normalize.js';

export interface OllamaEmbedderOptions {
  /** Base URL of the Ollama server, e.g. `http://localhost:11434`. */
  baseURL: string;
  /** Ollama model tag, e.g. `nomic-embed-text`. */
  model: string;
  /** Target dimensionality (defaults to {@link EMBED_DIM}). */
  dim?: number;
}

interface OllamaResponse {
  embedding?: number[];
}

/** Read up to a few hundred chars of the error body for diagnostics. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '<unreadable response body>';
  }
}

/**
 * Build an Ollama embedder. Construction is synchronous and makes no network
 * calls. Each `embed()` POSTs the source text to `<baseURL>/api/embeddings`.
 */
export function ollamaEmbedder(opts: OllamaEmbedderOptions): EmbedFn {
  const targetDim = opts.dim ?? EMBED_DIM;
  const base = opts.baseURL.replace(/\/+$/, '');

  return async (text: string): Promise<Float32Array> => {
    if (!opts.baseURL) {
      throw new Error(
        'ollama embedder is not configured: baseURL is required (set context.embedder.baseURL, e.g. http://localhost:11434)',
      );
    }

    const res = await fetch(`${base}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: opts.model, prompt: text }),
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `ollama embedder request failed (${res.status} ${res.statusText}): ${detail}`,
      );
    }

    const json = (await res.json()) as OllamaResponse;
    const vec = json.embedding ?? [];

    if (vec.length < targetDim) {
      throw new Error(
        `ollama model "${opts.model}" returned a ${vec.length}-dim vector (shorter than the required ${targetDim}); choose a >= ${targetDim}-dim model (e.g. nomic-embed-text)`,
      );
    }

    // Matryoshka truncate to the vec0 width, then re-normalize (DS-8).
    const truncated =
      vec.length > targetDim ? Float32Array.from(vec.slice(0, targetDim)) : Float32Array.from(vec);
    return l2normalize(truncated);
  };
}
