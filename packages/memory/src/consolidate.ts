// Consolidation for @noir-ai/memory (slice S7, task t5).
//
// The explicit, append-only, provider-gated consolidation job (DS-6). Extracted
// from the engine into its own module so the algorithm — gate → gather
// candidates → synthesize ONE lesson via the S8 bounded model → append the
// derived row — is unit-testable in isolation (no sqlite-vec, no embedder: the
// engine passes an `indexDerived` callback that performs the actual write). The
// engine delegates here; the engine still owns the store handle, the embedder,
// and the FTS5+vec+KV write path (`indexObservation`, shared with `save`).
//
// Blueprint D6 / §9 hard rules enforced here (non-negotiable):
//   • Provider-EXPLICIT — the provider is resolved ONLY from
//     `config.consolidation.provider`; it is NEVER inferred from env-var
//     presence. No explicit, enabled provider ⇒ refuse + log (`no-provider`)
//     and NO S8 call is made. This is the line between free (store) and paid
//     (LLM) — NEVER a silent paid call (the Agent-Memory anti-pattern, §9).
//   • Append-only — on success a DERIVED `type:'lesson'` row is appended with
//     `provenance:[candidate ids]`; the original observations are NEVER mutated
//     or deleted (reversible + auditable, DS-6).
//   • Single-shot (D5) — one `complete()` call, free-text → lesson body. There
//     is no `tools` / `stream` parameter on the request and no loop here.
//   • Canonical ProjectId — the lesson's `project` is the engine's canonical
//     id (NEVER a filesystem path — D6).
//
// A refusal is NEVER a crash and NEVER silent: every miss is recorded in the
// `memory:consolidation:miss` KV audit log (`logged:true`) so the user can see
// exactly why no lesson was written — and that NO paid call was made.

import { randomUUID } from 'node:crypto';
import type { Store } from '@noir-ai/store';
// TYPE-ONLY import: the model injection lives in engine.ts (it is also referenced
// by MemoryEngineOptions.model). Erased at runtime, so there is NO module cycle —
// engine.ts imports `runConsolidation` (value) from here; this file imports only
// the `MemoryModel` TYPE from engine.ts.
import type { MemoryModel } from './engine.js';
import { appendConsolidationMiss, getObservation, getObservationIds } from './store.js';
import {
  type ConsolidateOptions,
  type ConsolidationResult,
  DEFAULT_IMPORTANCE,
  type MemoryConfig,
  type Observation,
  type ProjectId,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cap on consolidation candidates (spec §7.4 — deterministic selection). */
export const DEFAULT_CONSOLIDATE_LIMIT = 50;

/**
 * Single-shot consolidation instruction (D5: no tools, no loop). The lesson is
 * free-text PROSE (not JSON): a lesson is a synthesized insight, and free-text
 * avoids a JSON-parse/repair round on what is naturally unstructured output.
 */
export const CONSOLIDATION_SYSTEM_PROMPT = [
  "You are consolidating a developer's cross-session memory observations.",
  'Synthesize the given observations into ONE concise derived lesson.',
  'State the general insight; do not merely list the inputs.',
  'Output only the lesson text (no preamble, no JSON, no formatting).',
].join(' ');

// ---------------------------------------------------------------------------
// Deps (the engine supplies these; tests fake them)
// ---------------------------------------------------------------------------

/**
 * Capabilities `runConsolidation` needs from the engine. The engine owns the
 * store handle + the embedder; `indexDerived` is the callback that writes a
 * derived observation to every index (embed → FTS5 + vec + KV + id index),
 * reusing the engine's shared `indexObservation` path so a lesson lands exactly
 * like a user-saved observation. Consolidation itself never touches the
 * embedder or the write path directly — it builds the lesson row + hands it off.
 */
export interface ConsolidationDeps {
  /** The daemon's single-writer store handle (possibly read-only — D6). */
  store: Store;
  /** Optional S8 model injection; absent ⇒ `'model-unavailable'` refusal. */
  model: MemoryModel | undefined;
  /** Runtime memory config (the provider-explicit consolidation gate). */
  config: MemoryConfig;
  /** Canonical project identifier (NEVER a filesystem path — D6). */
  projectId: ProjectId;
  /**
   * Write a derived lesson observation to all indexes. The engine implements
   * this as `embedBestEffort(content)` then the shared `indexObservation(obs,
   * vec)` — so the lesson is searchable (BM25 + vec) + hydrated from KV just
   * like a user save.
   */
  indexDerived: (observation: Observation) => Promise<void>;
}

// ---------------------------------------------------------------------------
// runConsolidation — the explicit, provider-gated job (DS-6)
// ---------------------------------------------------------------------------

/**
 * Run one explicit consolidation pass.
 *
 * Gate order (each refusal logs to `memory:consolidation:miss` and returns
 * `logged:true`; NONE makes a paid call before its gate passes):
 *  1. `no-provider` — consolidation not enabled OR no explicit `provider`
 *     configured. The provider is NEVER inferred from env-var presence (D5/D6).
 *  2. `model-unavailable` — enabled + provider set, but the S8 model injection
 *     is absent OR no explicit `model` id is configured (the documented S7 stub,
 *     OQ-3/OQ-8). Also the refusal when `complete()` returns `null` (provider
 *     not resolvable at call time — e.g. key missing) OR `{ok:false}` (an
 *     attempted call failed): both are wrapped as `'model-unavailable'`.
 *  3. `no-candidates` — nothing matches the (optional) type filter / lookback,
 *     OR the model returned empty text.
 *
 * On success: appends ONE derived `type:'lesson'` observation with
 * `provenance:[candidate ids]` via `indexDerived`; originals are NEVER mutated
 * (append-only — reversible + auditable, DS-6).
 */
export async function runConsolidation(
  deps: ConsolidationDeps,
  opts?: ConsolidateOptions,
): Promise<ConsolidationResult> {
  const { store, model, config, projectId, indexDerived } = deps;
  const cons = config.consolidation;
  const provider = cons?.provider;

  // GATE 1 — provider-explicit (D5/D6/DS-6). The provider is NEVER inferred
  // from env-var presence; no explicit, enabled provider ⇒ refuse + log, and
  // NO S8 call is made. This is the line between free (store) and paid (LLM).
  if (!cons?.enabled || !provider) {
    appendConsolidationMiss(store, { ts: Date.now(), reason: 'no-provider' });
    return { ok: false, reason: 'no-provider', logged: true };
  }

  // GATE 2 — the S8 bounded model layer must be injected AND an explicit model
  // id configured. Its absence is the documented S7 stub (OQ-3/OQ-8): refuse +
  // log, never crash, never a call.
  if (model === undefined || !cons.model) {
    appendConsolidationMiss(store, {
      ts: Date.now(),
      reason: 'model-unavailable',
      provider,
    });
    return { ok: false, reason: 'model-unavailable', logged: true };
  }
  const modelId = cons.model;

  // Candidates: deterministic selection (no clustering LLM). Recent first;
  // never consolidate an existing lesson; honor the optional type filter.
  // `opts.types` overrides the configured filter; `opts.limit` caps the set.
  const candidates = gatherCandidates(
    store,
    opts?.types ?? cons.types,
    opts?.limit ?? DEFAULT_CONSOLIDATE_LIMIT,
  );
  if (candidates.length === 0) {
    appendConsolidationMiss(store, {
      ts: Date.now(),
      reason: 'no-candidates',
      provider,
    });
    return { ok: false, reason: 'no-candidates', logged: true };
  }

  // Single-shot synthesis (D5: no `tools`, no loop). Free-text → lesson body.
  const result = await model.complete({
    system: CONSOLIDATION_SYSTEM_PROMPT,
    prompt: serializeCandidates(candidates),
    provider,
    model: modelId,
    tier: 'consolidate',
  });
  if (result === null || !result.ok) {
    // null = provider not resolvable at call time (key missing / block absent);
    // ok:false = an attempted call failed. Either way: no lesson written; the
    // task approach wraps BOTH as a failure reason. Log + refuse (never crash).
    appendConsolidationMiss(store, {
      ts: Date.now(),
      reason: 'model-unavailable',
      provider,
    });
    return { ok: false, reason: 'model-unavailable', logged: true };
  }

  const text = result.text.trim();
  if (text.length === 0) {
    // Model returned empty — treat as nothing to synthesize (no-candidates).
    appendConsolidationMiss(store, {
      ts: Date.now(),
      reason: 'no-candidates',
      provider,
    });
    return { ok: false, reason: 'no-candidates', logged: true };
  }

  // Append the derived lesson (originals UNTOUCHED — append-only, DS-6). The
  // lesson inherits the baseline salience + the de-duplicated concept tags from
  // its sources; `files` is empty (a lesson is project-level, not file-scoped).
  const provenance = candidates.map((c) => c.id);
  const ts = Date.now();
  const lesson: Observation = {
    id: randomUUID(),
    type: 'lesson',
    content: text,
    project: projectId,
    sessionId: null,
    ts,
    lastAccessTs: ts,
    importance: DEFAULT_IMPORTANCE,
    concepts: dedupeConcepts(candidates),
    files: [],
    source: 'explicit',
    provenance,
  };
  await indexDerived(lesson);
  return { ok: true, lessons: [lesson], from: provenance };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for direct unit testing — mirrors @noir-ai/context
// exporting its pure RRF / snippet helpers)
// ---------------------------------------------------------------------------

/**
 * Gather consolidation candidates: observations with `type != 'lesson'`,
 * newest-first, optionally restricted to `types`, capped at `limit`. Pure read
 * off the id index + KV — no LLM, no clustering (spec §7.4). Exported so the
 * deterministic selection is testable without a model.
 */
export function gatherCandidates(
  store: Store,
  types: ReadonlyArray<string> | undefined,
  limit: number,
): Observation[] {
  const ids = getObservationIds(store);
  const out: Observation[] = [];
  // Iterate newest-first (the id index is append/oldest-first).
  for (let i = ids.length - 1; i >= 0 && out.length < limit; i--) {
    const id = ids[i];
    if (id === undefined) break;
    const obs = getObservation(store, id);
    if (obs === null) continue;
    if (obs.type === 'lesson') continue; // never re-consolidate a lesson
    if (types !== undefined && !types.includes(obs.type)) continue;
    out.push(obs);
  }
  return out;
}

/**
 * Serialize candidates into the consolidation prompt body (deterministic order,
 * 1-indexed, with type + ts for the model's context). Pure.
 */
export function serializeCandidates(candidates: ReadonlyArray<Observation>): string {
  return candidates
    .map((c, i) => `[${i + 1}] (type: ${c.type}, ts: ${c.ts}) ${c.content}`)
    .join('\n\n');
}

/**
 * De-duplicate + collect concept tags across the candidate set (becomes the
 * derived lesson's `concepts`). Order is first-seen; pure.
 */
export function dedupeConcepts(candidates: ReadonlyArray<Observation>): string[] {
  const set = new Set<string>();
  for (const c of candidates) {
    for (const concept of c.concepts) set.add(concept);
  }
  return [...set];
}
