// Memory config resolver for @noir-ai/memory (slice S7, task t6).
//
// The single bridge from @noir-ai/core's user-facing `memory` zod schema to the
// runtime {@link MemoryConfig} the memory engine (and `runConsolidation`) consume.
// Lives HERE, in memory, so @noir-ai/core never imports @noir-ai/memory
// (no core→memory cycle): core owns the user-facing schema, memory owns the
// engine type + this mapper (mirrors @noir-ai/context's `resolveEmbedderConfig`
// and @noir-ai/model's `resolveModelConfig` — blueprint / hard rule). The fully-
// resolved zod output is structurally assignable to the permissive
// {@link MemoryUserConfig} mirror below, so the mapper accepts a
// `NoirConfig['memory']` directly — callers pass `resolveMemoryConfig(cfg.memory)`.
//
// Provider-EXPLICIT, never silent paid (blueprint D5/D6, DS-6): this mapper is a
// PURE projection of what the user wrote — it NEVER infers a provider from
// env-var presence. No explicit `consolidation.provider` ⇒ a disabled runtime
// config ⇒ `runConsolidation` refuses with `'no-provider'` + writes a miss audit
// and makes NO S8 `complete()` call. This is the line between free (store/embed)
// and paid (LLM) — NEVER a silent paid call (the Agent-Memory anti-pattern, §9).
// The mapper reads NO environment, holds NO secrets, and never throws — an
// unusable config stays a clean disabled default.

import type { MemoryConfig } from './types.js';

/**
 * User-facing memory config shape — mirrors `NoirConfig['memory']` (the zod block
 * @noir-ai/core ships, slice S7 / task t6). Declared LOCALLY with every field
 * optional so this module type-checks WITHOUT a forward dependency on a core
 * type (core never imports memory — no cycle; @noir-ai/core is not even
 * consulted here), AND so a config with no `memory:` block (or a partial one)
 * maps cleanly to a fully-disabled runtime config. The fully-resolved zod output
 * is structurally assignable to this permissive shape, so the mapper accepts a
 * `NoirConfig['memory']` directly.
 */
export interface MemoryUserConfig {
  /** Consolidation gate (provider-explicit — never silent paid, DS-6). */
  consolidation?: {
    /** Master switch (default false). When false, `consolidate` refuses + logs. */
    enabled?: boolean;
    /** Provider key, e.g. 'anthropic' | 'openai' | 'ollama'. Required to run. */
    provider?: string;
    /** Provider-specific model id. */
    model?: string;
    /** Restrict candidates to these types (default: every non-`lesson` type). */
    types?: string[];
  };
}

/**
 * Resolve a user-facing {@link MemoryUserConfig} into the runtime
 * {@link MemoryConfig} the memory engine (and `runConsolidation`) consume.
 *
 * - `undefined` / missing block ⇒ `{ consolidation: { enabled: false } }`
 *   (consolidation disabled — the safe default; capture/store/retrieve stay
 *   local + free. `runConsolidation` then refuses with `'no-provider'` + logs,
 *   making NO paid call, blueprint D6).
 * - A block whose `consolidation.enabled` is absent or `false` ⇒ the same
 *   disabled default, regardless of any `provider`/`model` written alongside it
 *   (the master switch is the first gate `runConsolidation` checks).
 * - A block with `consolidation.enabled === true` + a `provider` ⇒ the provider
 *   + optional `model`/`types` pass straight through; `runConsolidation` then
 *   proceeds to its model-availability + candidate gates.
 *
 * `consolidation` is ALWAYS populated (with `enabled` defaulted) so consumers
 * read `config.consolidation.enabled` without a separate undefined check —
 * mirrors how `resolveModelConfig` normalizes `tiers`/`providers` to
 * always-present objects.
 *
 * This mapper is a PURE projection — it copies fields through unchanged, NEVER
 * infers a provider from env-var presence (DS-6), reads NO environment, holds NO
 * secrets, and never throws. Whether a configured provider is actually USABLE is
 * decided at call time inside `complete()` (S8, which re-reads env idempotently),
 * NOT here.
 */
export function resolveMemoryConfig(raw?: MemoryUserConfig): MemoryConfig {
  const cons = raw?.consolidation;
  // Destructure once into locals so every narrowing below is unambiguous (the
  // model + context bridges follow the same `const x = raw?.field` shape). TS
  // then narrows each local cleanly under strictNullChecks without re-checking
  // the optional chain on assignment.
  // `enabled` is defaulted to false: an absent OR explicitly-false block both
  // disable consolidation. Strict `=== true` so a stray truthy non-boolean
  // (impossible post-zod, possible from hand-built test input) never enables a
  // paid call by accident — provider-EXPLICIT means opt-in is deliberate.
  const enabled = cons?.enabled === true;
  const provider = cons?.provider;
  const model = cons?.model;
  const types = cons?.types;

  // Always populate `consolidation` with `enabled` defaulted, so consumers read
  // `config.consolidation.enabled` without a separate undefined check (mirrors
  // how resolveModelConfig normalizes `tiers`/`providers` to always-present
  // objects). An absent block ⇒ disabled — NEVER a silent paid call.
  const consolidation: NonNullable<MemoryConfig['consolidation']> = { enabled };
  // Pure passthrough — no normalization, no env inference, no defaults beyond
  // `enabled`. Optional fields are copied only when present so `undefined` never
  // overwrites a meaningful absent-with-a-default state downstream.
  if (provider !== undefined) consolidation.provider = provider;
  if (model !== undefined) consolidation.model = model;
  if (types !== undefined) consolidation.types = types;
  return { consolidation };
}
