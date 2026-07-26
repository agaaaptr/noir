// Opt-in REMOTE embeddings (OpenAI / Voyage / Cohere).
//
// DESIGN:
//   - Provider-explicit and NEVER the default. The caller selects `kind:'remote'`
//     with a concrete `provider` in config; there is no inference from env vars,
//     so source text is never silently sent to a cloud endpoint (D6 hard rule).
//   - `apiKey` absence does NOT throw at construction — the embedder builds
//     cleanly so `context_status` can report `kind:'remote'`, and `embed()`
//     throws a clear "not configured" error so the engine degrades to BM25-only
//     (F8) rather than crashing. This makes a misconfigured key observable
//     instead of fatal.
//   - Vectors are Matryoshka-truncated client-side to `dim` (default 384) and
//     re-normalized via the shared `l2normalize` (truncation shrinks the norm).
//     A vector SHORTER than `dim` is a hard config error (wrong model).
//
// This is a deliberately thin stub: it fetches the provider's embeddings
// endpoint directly with the global `fetch`. Full provider SDKs (streaming,
// retries, batching, structured usage) are post-v0 (plan §7).

import type { EmbedFn } from '../types.js';
import { EMBED_DIM, l2normalize } from './normalize.js';

export interface RemoteEmbedderOptions {
  /** Provider key: `'openai'` | `'voyage'` | `'cohere'` (others fall back to the OpenAI shape). */
  provider: string;
  /** API key. If absent, `embed()` throws a clear "not configured" error. */
  apiKey?: string;
  /** Provider-specific model id. */
  model: string;
  /** Target dimensionality (must be 384 to match the vec0 table). */
  dim?: number;
}

/** OpenAI-compatible embeddings endpoint; also the fallback for unknown providers. */
const OPENAI_DEFAULT = 'https://api.openai.com/v1/embeddings';

/** Known provider endpoints. Unknown providers reuse the OpenAI-compatible shape. */
const ENDPOINTS: Record<string, string> = {
  openai: OPENAI_DEFAULT,
  voyage: 'https://api.voyageai.com/v1/embeddings',
  cohere: 'https://api.cohere.com/v2/embed',
};

interface EmbeddingsResponse {
  data?: Array<{ embedding?: number[] }>;
  embeddings?: { float?: number[][] };
}

/** Best-effort body for the provider's embeddings endpoint. */
function buildRequestBody(provider: string, model: string, text: string): string {
  switch (provider) {
    case 'voyage':
      return JSON.stringify({ model, inputs: [text] });
    case 'cohere':
      return JSON.stringify({
        model,
        texts: [text],
        input_type: 'search_document',
        embedding_types: ['float'],
      });
    default:
      // OpenAI-compatible. We deliberately omit `dimensions` (only the
      // text-embedding-3-* family accepts it; others 400) and rely on
      // client-side Matryoshka truncation below for schema compatibility.
      return JSON.stringify({ model, input: text });
  }
}

/** Extract the first embedding vector from a provider response shape. */
function extractVector(json: EmbeddingsResponse, provider: string): number[] {
  if (provider === 'cohere') {
    const vec = json.embeddings?.float?.[0];
    return vec ?? [];
  }
  // openai / voyage / openai-compatible
  return json.data?.[0]?.embedding ?? [];
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
 * Build a remote (cloud) embedder. Construction is synchronous and makes no
 * network calls. Each `embed()` call POSTs the source text to the provider.
 */
export function remoteEmbedder(opts: RemoteEmbedderOptions): EmbedFn {
  const targetDim = opts.dim ?? EMBED_DIM;
  // String-literal fallback (not a second Record lookup): under
  // noUncheckedIndexedAccess, indexing a Record yields `string | undefined`, so
  // `ENDPOINTS[opts.provider] ?? ENDPOINTS.openai` stays `string | undefined`
  // and fails typecheck at the fetch() below. `?? OPENAI_DEFAULT` resolves to `string`.
  const endpoint = ENDPOINTS[opts.provider] ?? OPENAI_DEFAULT;

  return async (text: string): Promise<Float32Array> => {
    if (!opts.apiKey) {
      throw new Error(
        `remote embedder "${opts.provider}" is not configured: apiKey is required (set context.embedder.apiKey or the matching provider env var)`,
      );
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${opts.apiKey}`,
      },
      body: buildRequestBody(opts.provider, opts.model, text),
    });

    if (!res.ok) {
      const detail = await readErrorBody(res);
      throw new Error(
        `remote embedder "${opts.provider}" request failed (${res.status} ${res.statusText}): ${detail}`,
      );
    }

    const json = (await res.json()) as EmbeddingsResponse;
    const vec = extractVector(json, opts.provider);

    if (vec.length < targetDim) {
      throw new Error(
        `remote embedder "${opts.provider}" returned a ${vec.length}-dim vector (shorter than the required ${targetDim}); choose a >= ${targetDim}-dim model`,
      );
    }

    // Matryoshka truncate to the vec0 width, then re-normalize.
    const truncated =
      vec.length > targetDim ? Float32Array.from(vec.slice(0, targetDim)) : Float32Array.from(vec);
    return l2normalize(truncated);
  };
}
