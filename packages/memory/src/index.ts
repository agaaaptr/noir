// @noir-ai/memory — Noir's cross-session memory layer.
//
// Local-first, in-process memory: append-only observations (pattern /
// preference / architecture / bug / workflow / fact / decision / lesson) stored
// ON TOP of the existing @noir-ai/store (FTS5 docs + sqlite-vec + KV — NO schema
// migration), recalled via the S6 hybrid retriever reused as-is (BM25 + vec +
// RRF k=60) scoped to `source:'memory'`, and consolidated into derived
// `type:'lesson'` rows by an explicit, provider-gated job that consumes the S8
// bounded model.
//
// Blueprint D6 hard rules (non-negotiable):
//   • in-process only — NO sidecar / external server;
//   • canonical ProjectId — NEVER a filesystem path (observations are
//     project-scoped via the store's projectId-keyed DB; KV keys namespaced
//     `memory:`);
//   • capture / store / retrieve ALWAYS local + free;
//   • ANY LLM touch (consolidation) is OPT-IN + provider-explicit — refuse +
//     log if no provider, NEVER a silent paid call (the Agent-Memory
//     anti-pattern, §9);
//   • never truncate snippets — window-extract is inherited from the store/S6;
//     the full observation `content` is hydrated from the authoritative KV row
//     `memory:obs:<id>` on every recall.
//
// Public surface: the MemoryEngine (the
// `ctx.memory` service) + the store-layer KV helpers + the data-model types.

// --- Capture (host-neutral CaptureEvent → SaveInput mapper; opt-in, t7) ---
// The bridge a host hook (Claude Code PreToolUse/PostToolUse/UserPromptSubmit/
// Stop, or any future host) uses to turn its event into a `memory_save`-shaped
// SaveInput. Pure — NO I/O, NO network, NO LLM (capture is always local + free). Auto-capture is OPT-IN: the user installs the hooks template
// (templates/claude-hooks.md); `noir init`/`sync` NEVER wire it.
export {
  buildContent,
  CAPTURE_HOOKS,
  type CaptureEvent,
  type CaptureEventType,
  type CapturePayload,
  type CapturePolicy,
  captureSource,
  DEFAULT_CAPTURE_HOOKS,
  DEFAULT_CAPTURE_POLICY,
  describeToolCall,
  extractFiles,
  inferType,
  toSaveInput,
} from './capture.js';

// --- Config resolver (the core→memory bridge; pure projection) ---
// resolveMemoryConfig maps @noir-ai/core's user-facing `memory` zod block to the
// runtime MemoryConfig the engine consumes. Lives HERE (not in core) so core
// never imports memory (no core→memory cycle — mirrors @noir-ai/context's
// resolveEmbedderConfig + @noir-ai/model's resolveModelConfig). Pure projection:
// provider-EXPLICIT, reads NO env, never infers a provider — a missing
// block resolves to consolidation-disabled, so runConsolidation refuses +
// logs (`no-provider`) and makes NO paid S8 call.
export {
  type MemoryUserConfig,
  resolveMemoryConfig,
} from './config.js';
// --- Consolidation (explicit, provider-gated, append-only job) ---
// runConsolidation is the standalone algorithm extracted from the engine — the
// gate logic (no-provider / model-unavailable / no-candidates) + the derived
// `type:'lesson'` append. Pure helpers (gatherCandidates / serializeCandidates
// / dedupeConcepts) are exported for direct unit testing, mirroring how
// @noir-ai/context exports its pure RRF / snippet helpers.
export {
  CONSOLIDATION_SYSTEM_PROMPT,
  type ConsolidationDeps,
  DEFAULT_CONSOLIDATE_LIMIT,
  dedupeConcepts,
  gatherCandidates,
  runConsolidation,
  serializeCandidates,
} from './consolidate.js';

// --- Engine (the ctx.memory service; built once per serve lifecycle; t2) ---
export {
  createMemoryEngine,
  type MemoryCompleteRequest,
  type MemoryCompleteResult,
  MemoryEngineImpl,
  type MemoryEngineOptions,
  type MemoryModel,
} from './engine.js';

// --- Recall (hybrid BM25 ∪ kNN → RRF → entity-boost → KV hydration; t3) ---
// recallMemory is the standalone hybrid pipeline (reuses @noir-ai/context's
// fuseRrf, scoped to source:'memory', with a cheap regex entity-boost).
// extractEntities is exported for direct unit testing, mirroring how
// @noir-ai/context exports its pure RRF / snippet helpers.
export {
  extractEntities,
  type RecallDeps,
  type RecallMemoryResult,
  recallMemory,
} from './recall.js';
// --- Store layer (KV layout + single-key accessors + session RMW helpers; t2) ---
export {
  appendConsolidationMiss,
  bumpSession,
  CONSOLIDATION_MISS_KEY,
  type ConsolidationMiss,
  clearObservation,
  decrementSession,
  getConsolidationMisses,
  getObservation,
  getObservationIds,
  getSessions,
  INDEX_KEY,
  OBS_PREFIX,
  obsKey,
  SESSIONS_KEY,
  setObservation,
  setObservationIds,
  setSessions,
} from './store.js';
// --- Types (the data model + engine contract; t1) ---
export {
  type ConsolidateOptions,
  type ConsolidationConfig,
  type ConsolidationResult,
  DEFAULT_IMPORTANCE,
  type EmbedderConfig,
  type EmbedFn,
  type ForgetResult,
  MEMORY_TYPES,
  type MemoryConfig,
  type MemoryEngine,
  type MemoryHit,
  type MemorySource,
  type MemoryStatus,
  type MemoryType,
  type Observation,
  type ProjectId,
  type RecallOptions,
  type SaveInput,
  type SearchOptions,
  type SessionInfo,
} from './types.js';
