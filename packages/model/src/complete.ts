// complete() — the single bounded model entry point (slice S8, blueprint D5).
//
// HARD RULES enforced here, by construction:
//
// - Provider-EXPLICIT, never silent paid calls (DS-6): the provider is resolved
//   ONLY from the explicit `req.provider` (or `cfg.defaultProvider`). Env-var
//   presence is NEVER read to infer a provider — `ANTHROPIC_API_KEY` being set
//   for another tool does NOT make Anthropic active in Noir. No explicit,
//   configured provider ⇒ `null`.
// - null-degradation FIRST-CLASS (DS-5): the unconfigured / missing-key paths
//   return `null` (NEVER throw), so callers branch on presence and the full
//   Noir test suite runs offline + free. `null` is the always-available default.
// - SINGLE-SHOT (D5): there is no loop here — `complete()` dispatches one
//   adapter call and returns. The `CompleteRequest` type forbids `tools` /
//   `stream`, so even an adapter cannot turn this into an agent loop.
//
// The adapter registry is the seam slices t2/t3 fill: each adapter module
// calls {@link registerProviderAdapter} at import time. Until a configured
// provider has a registered adapter, `complete()` returns `{ ok: false, reason }`
// (a real misconfiguration, intentionally distinct from the first-class `null`
// degradation so callers can tell "offline" from "wired wrong").

import { runStructured } from './structured.js';
import type {
  CompleteRequest,
  CompleteResult,
  ModelConfig,
  ProviderAdapter,
  ProviderConfig,
  Tier,
} from './types.js';

// --- Adapter registry (the t2/t3 seam) --------------------------------------
//
// A plain module-level map. Adapters self-register on import; `complete()`
// looks one up by provider name. Kept here (not a separate file) because t1's
// file list is {index,types,complete} and the registry is small + tightly
// coupled to dispatch. `clearProviderAdapters` exists for test isolation.
const adapters = new Map<string, ProviderAdapter>();

/** Register a provider adapter under `name` (e.g. `anthropic`, `openai`). */
export function registerProviderAdapter(name: string, adapter: ProviderAdapter): void {
  adapters.set(name, adapter);
}

/** Look up a registered adapter by provider name (or `undefined`). */
export function getProviderAdapter(name: string): ProviderAdapter | undefined {
  return adapters.get(name);
}

/** Clear the registry. Exported for test isolation between cases. */
export function clearProviderAdapters(): void {
  adapters.clear();
}

// --- Key resolution ---------------------------------------------------------
//
// Secrets live in env vars; config holds only the env-var NAME (DS-8). A
// provider block with no `apiKeyEnv` is an ANONYMOUS local provider (Ollama,
// LM Studio) and is allowed to proceed with `undefined` — no auth header.
function resolveKey(providerCfg: ProviderConfig): string | undefined {
  if (!providerCfg.apiKeyEnv) return undefined; // anonymous local provider
  return process.env[providerCfg.apiKeyEnv];
}

// --- Per-tier output caps (FR-10) -------------------------------------------
//
// Applied when a request omits `maxTokens` AND signals a tier. A tier ONLY
// picks the output cap — it never selects a provider or model (DS-6), so this
// table is a flat budget map, not a routing table. When neither `maxTokens` nor
// a tier is given, the request keeps `maxTokens: undefined` and each adapter
// applies its own last-resort bound (e.g. the Anthropic Messages API's required
// `max_tokens` defaults to 2048 inside that adapter).
export const TIER_MAX_TOKENS: Readonly<Record<Tier, number>> = {
  draft: 2048,
  title: 64,
  summarize: 512,
  consolidate: 2048,
};

// --- Adapter resolution (t4) ------------------------------------------------
//
// A configured provider block is keyed by an arbitrary NAME the user picks
// (`anthropic`, `openai`, `ollama`, `lm-studio`, …). The ADAPTER set is fixed
// (`anthropic`, `openai`, `openai-compatible`). The two only coincide for the
// hosted built-ins; a local endpoint like Ollama is configured under a free-form
// name (e.g. `ollama`) but must reach the `openai-compatible` adapter.
//
// Resolution rule (the openai-compatible adapter's closing comment flags this as
// the t4 dispatch job):
//   1. DIRECT match — a registered adapter exists under `providerName` (covers
//      `anthropic`, `openai`, `openai-compatible`, and any custom-registered
//      adapter that self-registers under its provider name). Always preferred.
//   2. BASE URL fallback — a provider block with a `baseURL` but no direct
//      adapter is an OpenAI-shaped LOCAL endpoint (Ollama / LM Studio / vLLM),
//      so route it to `openai-compatible` (raw fetch, zero SDK dep — NFR-2).
//   3. otherwise undefined — a named provider with no adapter and no `baseURL`
//      is a wiring fault ⇒ `{ ok: false, reason }` (distinct from `null`).
function resolveAdapterName(providerName: string, providerCfg: ProviderConfig): string | undefined {
  if (getProviderAdapter(providerName)) return providerName; // direct
  if (providerCfg.baseURL) return 'openai-compatible'; // local OpenAI-shaped endpoint
  return undefined;
}

/**
 * Execute one bounded model call.
 *
 * Resolution + degradation order (each `null` is the first-class offline path):
 *  1. provider name — `req.provider || cfg.defaultProvider`. Empty ⇒ `null`.
 *  2. provider block — `cfg.providers[name]`. Absent ⇒ `null` (NOT configured,
 *     so NO consent to spend; env presence is never consulted — DS-6).
 *  3. key — `process.env[apiKeyEnv]`; `undefined` (anonymous) if no `apiKeyEnv`.
 *     A keyed provider whose env var is unset ⇒ `null` (the miss is observable
 *     via the `null` return; a structured usage/miss sink lands with t6).
 *  4. adapter — the provider NAME is mapped to an adapter (direct match, else a
 *     `baseURL` block routes to `openai-compatible`); unresolvable ⇒
 *     `{ ok: false, reason }`. The per-tier `maxTokens` default (FR-10) and the
 *     provider-block `baseURL` are folded onto the dispatched request here.
 *  5. dispatch — one call (or two via the structured repair retry when `schema`
 *     is set — DS-4); a throw becomes `{ ok: false, reason }` (never escapes).
 *
 * `null` (steps 1–3) is degradation → caller substitutes a template.
 * `{ ok: false }` (steps 4–5) is an attempted-call failure → caller may surface it.
 */
export async function complete(
  req: CompleteRequest,
  cfg: ModelConfig = {},
): Promise<CompleteResult> {
  // 1. Provider name — explicit only (NEVER inferred from env-var presence).
  const providerName = req.provider || cfg.defaultProvider;
  if (!providerName) return null;

  // 2. Provider block must be configured — explicit consent to spend. A name
  //    that isn't in `providers{}` is NOT a provider, regardless of env vars.
  const providerCfg = cfg.providers?.[providerName];
  if (!providerCfg) return null;

  // 3. Key resolution — env-var NAME → value; anonymous local providers OK.
  const key = resolveKey(providerCfg);
  if (providerCfg.apiKeyEnv && !key) return null;

  // 4. Adapter resolution — map the configured provider NAME to an adapter. The
  //    hosted built-ins (`anthropic`, `openai`) match directly; a free-form local
  //    name (e.g. `ollama`) with a `baseURL` routes to `openai-compatible`. No
  //    resolvable adapter ⇒ `{ ok: false }` (a wiring fault, NOT `null`).
  const adapterName = resolveAdapterName(providerName, providerCfg);
  const adapter = adapterName ? getProviderAdapter(adapterName) : undefined;
  if (!adapter) {
    return {
      ok: false,
      reason: providerCfg.baseURL
        ? `no adapter for provider "${providerName}" (baseURL set but the "openai-compatible" adapter is not registered)`
        : `no adapter registered for provider "${providerName}"`,
    };
  }

  // Forward provider-block config + the per-tier output cap onto the request so
  // the adapter stays uniform (ProviderAdapter.complete(req, key)):
  //   • baseURL — only `openai-compatible` consumes it (Ollama / LM Studio /
  //     vLLM endpoint); the hosted adapters simply ignore it.
  //   • maxTokens — apply the FR-10 per-tier default ONLY when the caller omitted
  //     it AND a tier is signalled. An explicit maxTokens always wins; absent both
  //     ⇒ `undefined`, and the adapter applies its own last-resort bound.
  const tierMax = req.tier ? TIER_MAX_TOKENS[req.tier] : undefined;
  const maxTokens = req.maxTokens ?? tierMax;
  const dispatchReq: CompleteRequest = {
    ...req,
    ...(providerCfg.baseURL ? { baseURL: providerCfg.baseURL } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  };

  // 5. Single bounded call; complete() never throws. When a `schema` is present
  //    the call routes through the structured path (prompt-JSON + validate + ≤1
  //    repair retry — the ONLY retry in the model layer, DS-4/DS-12). Otherwise a
  //    plain free-text adapter call. Either way at most two adapter invocations
  //    total, and no `tools`/`stream` exist on the request to loop on (FR-8).
  try {
    return dispatchReq.schema
      ? await runStructured(adapter, dispatchReq, key)
      : await adapter.complete(dispatchReq, key);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `provider "${providerName}" failed: ${reason}` };
  }
}
