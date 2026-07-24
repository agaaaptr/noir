// Embedder config resolver for @noir-ai/context (slice S6).
//
// The single bridge from @noir-ai/core's user-facing `context` zod schema to
// this package's discriminated {@link EmbedderConfig} (the `createEmbedFn`
// factory input). Lives HERE, in context, so @noir-ai/core never imports
// @noir-ai/context (no core→context cycle): core owns the user-facing schema,
// context owns the factory type + this mapper (blueprint / hard rule).
//
// Provider-explicit, NEVER silent remote (blueprint D6): `kind:'remote'` and
// `kind:'ollama'` are only selected when the user explicitly sets them in
// config. The default is `kind:'local'` — in-process, offline, free, private.
// Remote API keys are read from environment variables ONLY (secrets stay out of
// the config file, per the S8 model-layer convention); a missing key yields a
// config that builds cleanly but throws from `embed()` so the engine degrades
// to BM25-only (F8) rather than crashing at construction.

import type { EmbedderConfig } from './types.js';

/**
 * User-facing context config shape — mirrors `NoirConfig['context']` (the zod
 * block @noir-ai/core ships, slice S6). Declared locally with every field
 * optional so this module type-checks WITHOUT a forward dependency on a core
 * type (core never imports context — no cycle), AND so a config with no
 * `context:` block (or a partial one) parses cleanly (AC-7 / NFR-6). The fully
 * resolved zod output is structurally assignable to this permissive shape, so
 * the mapper accepts `NoirConfig['context']` directly.
 */
export interface ContextUserConfig {
  embedder?: {
    /** Default `'local'` (in-process transformers.js — offline, free, private). */
    kind?: 'local' | 'remote' | 'ollama' | 'none';
    /** Local HF repo id / remote provider model id / Ollama model tag. */
    model?: string;
    /** Remote provider key, e.g. `'openai'` (only meaningful when `kind:'remote'`). */
    provider?: string;
    /** Ollama base URL, e.g. `http://localhost:11434` (only when `kind:'ollama'`). */
    baseURL?: string;
    /** Target dimensionality (must be 384 to match the existing vec0 table). */
    dim?: number;
  };
  /** Configured index roots (informational here; the daemon/indexer consume them). */
  roots?: string[];
  /** Default token budget for `search` (informational here; consumed by the retriever). */
  budgetTokens?: number;
}

/**
 * The environment variable that carries the API key for a remote provider, or
 * `undefined` for an unknown provider (no inference — provider-explicit, D6).
 */
function apiKeyEnvVar(provider: string): string | undefined {
  switch (provider) {
    case 'openai':
      return process.env.OPENAI_API_KEY;
    case 'voyage':
      return process.env.VOYAGE_API_KEY;
    case 'cohere':
      return process.env.COHERE_API_KEY;
    default:
      return undefined;
  }
}

/**
 * Resolve a user-facing {@link ContextUserConfig} into the discriminated
 * {@link EmbedderConfig} the factory (`createEmbedFn`) consumes.
 *
 * - `undefined` / missing block ⇒ `{kind:'local'}` (the safe default — a config
 *   with no `context:` block stays local-embedder-attempted, AC-7 / NFR-6).
 * - `kind:'local'` ⇒ in-process transformers.js (model optional; factory
 *   defaults to `Xenova/all-MiniLM-L6-v2`).
 * - `kind:'none'` ⇒ vectors disabled; `search` degrades to BM25-only.
 * - `kind:'remote'` / `'ollama'` ⇒ provider-explicit; the API key (remote) /
 *   base URL (ollama) are resolved from env when absent in config. A missing
 *   key is NOT an error here — the built embedder throws from `embed()` so the
 *   engine degrades to BM25-only (F8) instead of crashing at construction.
 *
 * NEVER returns a remote/ollama config unless `kind` is explicitly that value —
 * there is no path from the default to a silent paid call (blueprint D6).
 */
export function resolveEmbedderConfig(ctx?: ContextUserConfig): EmbedderConfig {
  const e = ctx?.embedder;
  switch (e?.kind) {
    case 'local': {
      const model = e?.model;
      return { kind: 'local', ...(model ? { model } : {}) };
    }
    case 'remote': {
      // `e?.kind === 'remote'` implies `e` is defined; `e?.` is defensive.
      const provider = e?.provider ?? 'openai';
      const model = e?.model ?? '';
      const dim = e?.dim ?? 384;
      const apiKey = apiKeyEnvVar(provider);
      return { kind: 'remote', provider, model, dim, ...(apiKey ? { apiKey } : {}) };
    }
    case 'ollama': {
      const baseURL = e?.baseURL ?? process.env.OLLAMA_BASE_URL ?? '';
      const model = e?.model ?? '';
      return { kind: 'ollama', baseURL, model };
    }
    case 'none':
      return { kind: 'none' };
    default:
      // undefined / unknown kind ⇒ safe local default. NEVER a silent remote call.
      return { kind: 'local' };
  }
}
