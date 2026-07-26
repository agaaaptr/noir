// Type contracts for @noir-ai/model (slice S8).
//
// Blueprint D5 hard rules are enforced AT THE TYPE LEVEL so an agent loop
// cannot be expressed through this surface even by a careless caller:
//
// - SINGLE-SHOT ONLY — {@link CompleteRequest} carries no `tools`, `functions`,
//   or `stream` field. Without a tool parameter there is no way to construct a
//   tool/exec loop here; the type itself is the tripwire.
// - Provider-EXPLICIT — `provider` is a REQUIRED field, and resolution in
//   `complete()` never reads env-var presence to pick one. No explicit,
//   configured provider ⇒ `null`.
// - null-degradation FIRST-CLASS — {@link CompleteResult} includes `null` as a
//   peer variant (no provider configured ⇒ degrade to a caller template). It
//   is never an exception, so callers branch on presence and the full Noir
//   suite runs offline + free.
//
// `ZodType` is referenced TYPE-ONLY (`import type`): the model layer ACCEPTS a
// caller-supplied schema for structured output but never instantiates zod at
// runtime, so the built library has no value-level zod dependency (peer-only);
// the structured path that actually consumes the schema lands in slice t4.

import type * as z from 'zod/v4';

/**
 * A caller-supplied output contract for structured completion.
 *
 * Either a zod schema (its `.parse()` is the validator) or a raw validate-and-
 * coerce function `unknown → unknown` (throw on invalid). The structured path
 * (slice t4) instructs the model to emit JSON, parses it, then runs this; a
 * failure triggers a single repair retry, then degradation to `null`.
 */
export type CompleteSchema = z.ZodType | ((raw: unknown) => unknown);

/**
 * The four bounded task tiers. A tier is an OPTIONAL budget hint on a
 * request — it selects a per-tier `maxTokens` default when the caller omits
 * `maxTokens` (FR-10). A tier NEVER selects a provider or model: those stay
 * explicit on the request (provider-explicit, never inferred from env).
 * Tier→provider/model resolution is the caller's job (it reads resolved config);
 * `complete()` only consumes the tier for the output-cap default.
 */
export type Tier = 'draft' | 'title' | 'summarize' | 'consolidate';

/**
 * One bounded model call. Deliberately minimal — there is NO `tools`,
 * `functions`, or `stream` field, so by construction this surface cannot
 * express an agent or tool-exec loop (blueprint D5). `signal` lets a caller
 * bound wall-clock further (abort); there is never a stream to cancel.
 */
export interface CompleteRequest {
  /** Optional system prompt (role: system). */
  system?: string;
  /** The user prompt (role: user). Required — the task to complete. */
  prompt: string;
  /** Optional structured-output contract; presence routes via the JSON path. */
  schema?: CompleteSchema;
  /** Provider block name (key into {@link ModelConfig.providers}). Explicit. */
  provider: string;
  /** Model id for this call (e.g. `claude-haiku`, `gpt-4o-mini`). */
  model: string;
  /** Output cap in tokens; omit to use the adapter/tier default (FR-10). */
  maxTokens?: number;
  /**
   * Optional task tier. When `maxTokens` is absent AND a tier is set,
   * `complete()` applies the per-tier output cap (FR-10: draft 2048 / title 64 /
   * summarize 512 / consolidate 2048). Never selects provider/model.
   */
  tier?: Tier;
  /**
   * Base URL for an OpenAI-compatible endpoint (Ollama / LM Studio / vLLM),
   * e.g. `http://localhost:11434/v1`. NOT caller-set: `complete()` forwards it
   * from the resolved provider block (`cfg.providers[name].baseURL`) so the
   * `openai-compatible` adapter — the only consumer — receives its endpoint. It
   * is optional and ignored by the `anthropic` / `openai` (hosted) adapters.
   */
  baseURL?: string;
  /** Optional abort signal to bound the call (single shot, no streaming). */
  signal?: AbortSignal;
}

/**
 * Token accounting for a successful call. Carries COUNTS only — never prompts
 * or keys (NFR-4: values are never logged alongside usage).
 */
export interface CompleteUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * The result of a bounded model call. Three first-class variants:
 *
 * - `{ ok: true, text, value?, usage? }` — completion succeeded. `text` is the
 *   raw model output; `value` is present ONLY on the structured path (when a
 *   `schema` was supplied and the parsed+validated JSON object is returned —
 *   FR-1: structured mode returns an `object`). Free-text calls leave `value`
 *   unset, so callers branch `if ('value' in result)` to consume structured.
 * - `{ ok: false, reason }` — a call was ATTEMPTED (provider configured + key
 *   present + adapter ran) but failed (network, non-2xx, parse error, or the
 *   structured path failed JSON parse/validate twice). This is a recoverable
 *   error a caller may surface; it is NOT degradation.
 * - `null` — DEGRADATION: no provider was configured, or a keyed provider's
 *   env var was missing. The caller substitutes a template/stub (blueprint D5:
 *   "degrades to templates when no provider"). This is the always-available
 *   offline path; the full Noir test suite exercises it with zero network.
 */
export type CompleteResult =
  | { ok: true; text: string; value?: unknown; usage?: CompleteUsage }
  | { ok: false; reason: string }
  | null;

/**
 * A provider adapter implements one backend (`anthropic` / `openai` /
 * `openai-compatible`). Adapters register into the module registry in
 * `complete.ts` and dispatch by `CompleteRequest.provider`. `key` is the
 * resolved secret (read from env by `complete()`, never by the adapter), or
 * `undefined` for anonymous local providers (Ollama). Adapters MUST NOT retry
 * beyond the bounded single shot + ≤1 JSON-repair retry.
 */
export interface ProviderAdapter {
  name: string;
  complete(req: CompleteRequest, key?: string): Promise<CompleteResult>;
}

/**
 * One configured provider block — mirrors a `model.providers[name]` entry in
 * `.noir/config.yml`. `apiKeyEnv` is the NAME of the environment variable that
 * holds the secret, NEVER the value itself, so the config file stays safe to
 * commit and share (blueprint D5); `complete()` reads the value at call
 * time only.
 */
export interface ProviderConfig {
  /** Default model id for this provider (a call's `req.model` overrides). */
  model?: string;
  /** Base URL for openai-compatible endpoints (Ollama / LM Studio / …). */
  baseURL?: string;
  /** Env-var NAME holding the API key; omit for anonymous local providers. */
  apiKeyEnv?: string;
}

/**
 * The model-layer config slice. Mirrors the user-facing `model:` block added to
 * `NoirConfigSchema`; every field is optional so an absent
 * `model:` block resolves to `{}` — full degradation, offline, the default.
 * `complete(req, cfg)` consumes this directly with no dependency on `@noir-ai/core`
 * (the core→model bridge is kept external, avoiding a cycle), and the fully-resolved
 * zod output is structurally assignable to this permissive shape.
 */
export interface ModelConfig {
  /** Fallback provider name when a call's `req.provider` is empty/unset. */
  defaultProvider?: string;
  /** Configured provider blocks, keyed by provider name. */
  providers?: Record<string, ProviderConfig>;
}
