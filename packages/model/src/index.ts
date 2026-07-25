// @noir-ai/model — Noir's bounded single-shot model layer (slice S8).
//
// A thin LIBRARY (NOT a host/MCP surface — blueprint D5 / DS-1): one
// `complete()` function backed by provider adapters (`anthropic` / `openai` /
// `openai-compatible`). It is consumed IN-PROCESS by S4 (artifact drafting),
// S7 (memory consolidation), and S9 (home help) to fill bounded content slots
// on explicit request. It can express ONLY a single completion — there is no
// `tools` / `stream` parameter, so an agent or tool-exec loop cannot be built
// on it. When no provider is configured (or a keyed provider's env var is
// missing) `complete()` returns `null` and callers substitute a template — the
// always-available offline path (first-class, fully tested).
//
// No MCP tools are registered here (DS-1): the daemon `ServerContext` is NOT
// extended with a model service. Packages that need drafting import `complete`
// directly; this keeps the model layer unreachable from the host and enforces
// D5 at the boundary.

export {
  clearProviderAdapters,
  complete,
  getProviderAdapter,
  registerProviderAdapter,
  TIER_MAX_TOKENS,
} from './complete.js';
// --- Config mapper (core user schema → runtime shape; avoids core→model cycle) ---
export {
  type ModelProviderEntry,
  type ModelUserConfig,
  type ResolvedModelConfig,
  type ResolvedProviderConfig,
  type ResolvedTiers,
  resolveModelConfig,
} from './config.js';
// --- Bounded draft helpers (slice P / debt-batch A — single-shot PRD drafting) ---
export {
  type DraftPrdInput,
  type DraftPrdOptions,
  draftPrd,
  PRD_FALLBACK_TEMPLATE,
} from './draft.js';
export type {
  CompleteRequest,
  CompleteResult,
  CompleteSchema,
  CompleteUsage,
  ModelConfig,
  ProviderAdapter,
  ProviderConfig,
  Tier,
} from './types.js';

// --- Provider adapter self-registration (t2/t3 seam) ------------------------
//
// Side-effect imports ONLY. Each adapter module calls `registerProviderAdapter`
// at module load, so any consumer that imports `@noir-ai/model` gets the wired
// adapters automatically and `complete()` can dispatch by provider name. This
// does NOT pull the provider SDKs into the bundle at registration time: `openai`
// and `@anthropic-ai/sdk` are imported DYNAMICALLY inside their adapters'
// `complete()`, and `openai-compatible` uses the global `fetch` with zero deps —
// so a tree-shaken CLI that never selects a hosted adapter ships no hosted-SDK
// bytes (NFR-2 import isolation). The `complete.js` re-export above is evaluated
// BEFORE these side-effect imports, so the registry (`adapters` Map) is already
// initialized when each adapter's self-registration runs (no TDZ on the cycle
// back through `registerProviderAdapter`).
import './providers/anthropic.js';
import './providers/openai-compatible.js';
import './providers/openai.js';
