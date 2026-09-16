// Model config resolver for @noir-ai/model.
//
// The single bridge from @noir-ai/core's user-facing `model` zod schema to the
// runtime shape `complete()` (and `noir doctor`) consume. Lives HERE, in model,
// so @noir-ai/core never imports @noir-ai/model (no core→model cycle): core owns
// the user-facing schema, model owns this mapper + the runtime types. The
// fully-resolved zod output is structurally assignable to
// the permissive {@link ModelUserConfig} mirror below, so the mapper accepts a
// `NoirConfig['model']` directly — callers pass `resolveModelConfig(cfg.model)`.
//
// Provider-EXPLICIT, never silent paid: this mapper is a PURE projection
// of what the user wrote — it never selects a provider from env-var presence.
// Whether a configured provider is actually USABLE (key present) is reported as
// `hasKey` for inspection (`noir doctor`); it does NOT change the provider set.
// The first-class `null`-degradation decision lives in `complete()`, which reads
// the same env at call time — both readings are idempotent and stay in-process.
//
// Secrets stay in env: `apiKeyEnv` is the env-var NAME (passthrough, safe
// to print); `apiKey` is the VALUE resolved here from `process.env[apiKeyEnv]`,
// materialized so doctor / direct consumers can branch without each re-reading
// env. The value never touches disk via Noir and is never logged with usage.
// `authTokenEnv` travels through as a NAME only — whether it is set feeds
// `hasKey` (a boolean, never the value); the value itself is read at call
// time in `complete()`, alongside the key it already resolves there.

/**
 * User-facing model config shape — mirrors `NoirConfig['model']` (the zod block
 * @noir-ai/core ships). Declared LOCALLY with every field optional so
 * this module type-checks WITHOUT a forward dependency on a core type (core
 * never imports model — no cycle; @noir-ai/model is not even in this package's
 * node_modules), AND so a config with no `model:` block (or a partial one) maps
 * cleanly to a fully-degraded runtime config. The fully-resolved zod output is
 * structurally assignable to this permissive shape, so the mapper accepts
 * `NoirConfig['model']` directly.
 */
export interface ModelUserConfig {
  /** Fallback provider key (into `providers`) when a tier resolves none. */
  defaultProvider?: string;
  /** Per-tier provider-key overrides (value = key into `providers{}`). */
  tiers?: {
    draft?: string;
    title?: string;
    summarize?: string;
    consolidate?: string;
  };
  /** Configured provider blocks, keyed by provider name. */
  providers?: Record<string, ModelProviderEntry>;
}

/**
 * One user-facing provider block — mirrors a `model.providers[name]` entry in
 * `.noir/config.yml`. `model` is optional HERE (the mirror is permissive) even
 * though the zod schema requires it, so hand-built configs in tests type-check;
 * `resolveModelConfig` passes `model` straight through when present.
 */
export interface ModelProviderEntry {
  /** Default model id for this provider (a call's `req.model` overrides). */
  model?: string;
  /** Base URL for openai-compatible endpoints (Ollama / LM Studio / …). */
  baseURL?: string;
  /** Env-var NAME holding the API key; omit for anonymous local providers. */
  apiKeyEnv?: string;
  /** Env-var NAME holding a bearer token (Authorization: Bearer); NAME only. */
  authTokenEnv?: string;
  /** Per-request timeout in milliseconds; omit for the adapter default. */
  timeoutMs?: number;
}

/**
 * A provider block with its key RESOLVED from the environment. Superset of the
 * runtime `ProviderConfig` (`@noir-ai/model`'s `complete()` consumes), so a
 * {@link ResolvedModelConfig} drops cleanly into `complete(req, cfg)` — the extra
 * `apiKey` / `hasKey` fields are ignored by `complete()` (which re-reads env at
 * call time, idempotently) and exist for `noir doctor` + direct consumers.
 */
export interface ResolvedProviderConfig {
  /** Provider model id (passthrough from config). */
  model?: string;
  /** Base URL passthrough (openai-compatible endpoints). */
  baseURL?: string;
  /** Env-var NAME passthrough — doctor prints this, NEVER the value. */
  apiKeyEnv?: string;
  /** Env-var NAME passthrough for the bearer token (same rule as apiKeyEnv). */
  authTokenEnv?: string;
  /** Per-request timeout passthrough (milliseconds). */
  timeoutMs?: number;
  /** VALUE resolved from `process.env[apiKeyEnv]`; `undefined` if anonymous or unset. */
  apiKey?: string;
  /**
   * Readiness signal for `noir doctor`: whether a keyed provider has at least
   * one of its named credential env vars set (`apiKeyEnv` and/or `authTokenEnv`);
   * an ANONYMOUS provider (neither named) is always `true` — no credential is
   * required, so nothing is missing. Carries a boolean ONLY, never the value.
   */
  hasKey: boolean;
}

/**
 * Per-tier provider-key overrides, normalized to a full object (absent `tiers`
 * ⇒ `{}`) so consumers index without a separate undefined check.
 */
export interface ResolvedTiers {
  draft?: string;
  title?: string;
  summarize?: string;
  consolidate?: string;
}

/**
 * The resolved model-layer config — the runtime shape `complete()` consumes and
 * `noir doctor` inspects. `providers` is always present (possibly `{}`); each
 * entry carries its resolved key. Assignable to `ModelConfig` (`complete()`'s
 * param type), so `complete(req, resolveModelConfig(cfg.model))` type-checks.
 */
export interface ResolvedModelConfig {
  /** Fallback provider key when a call resolves no explicit provider. */
  defaultProvider?: string;
  /** Per-tier provider-key overrides (absent ⇒ empty object). */
  tiers: ResolvedTiers;
  /** Provider blocks with resolved keys (absent ⇒ empty map). */
  providers: Record<string, ResolvedProviderConfig>;
}

/**
 * Resolve a user-facing {@link ModelUserConfig} into the runtime
 * {@link ResolvedModelConfig}.
 *
 * - `undefined` / missing block ⇒ `{ tiers: {}, providers: {} }` (full
 *   degradation — `complete()` will then return `null` for every call, the
 *   always-available offline path).
 * - Each provider's API key is materialized from `process.env[apiKeyEnv]` into
 *   `apiKey`; `hasKey` is `true` when a keyed provider has at least one of its
 *   named credential env vars set (doctor surfaces a miss; `complete()` returns
 *   `null`).
 * - Anonymous providers (neither `apiKeyEnv` nor `authTokenEnv`) keep
 *   `apiKey: undefined` but report `hasKey: true` (ready — no key needed, e.g.
 *   local Ollama).
 *
 * This mapper NEVER infers a provider from env-var presence and NEVER
 * mutates `raw` or `process.env` — it only READS env to resolve keys. It never
 * throws; an unusable config degrades to empty, not an exception.
 */
export function resolveModelConfig(raw?: ModelUserConfig): ResolvedModelConfig {
  const providers: Record<string, ResolvedProviderConfig> = {};

  // Destructure once into locals so every narrowing below is unambiguous (the
  // context bridge follows the same `const e = ctx?.embedder` shape). The input
  // is zod-validated or typed, so direct field access on each entry is safe.
  const rawProviders = raw?.providers;
  if (rawProviders) {
    for (const [name, entry] of Object.entries(rawProviders)) {
      const apiKeyEnv = entry.apiKeyEnv;
      const authTokenEnv = entry.authTokenEnv;
      // A keyed provider names at least one credential env var. It is ready
      // when AT LEAST ONE of those vars holds a value — the model layer sends
      // whichever resolved. Anonymous providers (neither named) need no
      // credential, so they are ready by default.
      const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
      const authToken = authTokenEnv ? process.env[authTokenEnv] : undefined;
      const keyed = Boolean(apiKeyEnv) || Boolean(authTokenEnv);
      // A credential set to the empty string is "unset", matching the runtime
      // path (complete.ts treats a falsy key as absent) so doctor and the model
      // layer never disagree about readiness.
      const hasKey =
        !keyed ||
        (apiKey !== undefined && apiKey !== '') ||
        (authToken !== undefined && authToken !== '');

      const resolved: ResolvedProviderConfig = { hasKey };
      if (entry.model !== undefined) resolved.model = entry.model;
      if (entry.baseURL !== undefined) resolved.baseURL = entry.baseURL;
      if (apiKeyEnv !== undefined) resolved.apiKeyEnv = apiKeyEnv;
      if (entry.authTokenEnv !== undefined) resolved.authTokenEnv = entry.authTokenEnv;
      if (entry.timeoutMs !== undefined) resolved.timeoutMs = entry.timeoutMs;
      if (apiKey !== undefined) resolved.apiKey = apiKey;
      providers[name] = resolved;
    }
  }

  const tiers: ResolvedTiers = {};
  const rawTiers = raw?.tiers;
  if (rawTiers) {
    if (rawTiers.draft !== undefined) tiers.draft = rawTiers.draft;
    if (rawTiers.title !== undefined) tiers.title = rawTiers.title;
    if (rawTiers.summarize !== undefined) tiers.summarize = rawTiers.summarize;
    if (rawTiers.consolidate !== undefined) tiers.consolidate = rawTiers.consolidate;
  }

  const result: ResolvedModelConfig = { tiers, providers };
  const defaultProvider = raw?.defaultProvider;
  if (defaultProvider !== undefined) result.defaultProvider = defaultProvider;
  return result;
}
