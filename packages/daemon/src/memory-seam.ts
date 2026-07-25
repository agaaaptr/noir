import type { EmbedFn } from '@noir-ai/context';
import type { ProjectId } from '@noir-ai/core';
import {
  createMemoryEngine,
  type MemoryConfig,
  type MemoryEngine,
  type MemoryModel,
} from '@noir-ai/memory';
import { complete, type ResolvedModelConfig } from '@noir-ai/model';
import type { Store } from '@noir-ai/store';

/**
 * Derive the consolidation provider + model id from a resolved MODEL config —
 * the MODEL-DERIVED FALLBACK used ONLY when the user enabled consolidation
 * under `memory:` but did NOT name a provider there (see
 * {@link resolveConsolidationCapability}). Blueprint D5/D6 — provider-EXPLICIT,
 * never env-inferred.
 *
 * The provider is resolved ONLY from an explicit opt-in: the `consolidate` tier
 * key, falling back to `defaultProvider`. Env-var presence is NEVER consulted
 * (DS-6) — `ANTHROPIC_API_KEY` being set for another tool does NOT activate
 * consolidation here. A provider is "consolidation-capable" only when that key
 * resolves to a configured provider block that itself declares a `model` id;
 * otherwise this returns `null`.
 *
 * NOTE: this function ALONE is NOT the consolidation gate — it ignores the
 * user's `memory.consolidation.enabled` master switch. The AND of that switch
 * with this derivation (and with the memory-block provider) lives in
 * {@link resolveConsolidationCapability}, which is what the daemon wiring +
 * {@link buildMemoryEngine} actually consult to decide tool registration.
 */
export function resolveMemoryConsolidation(
  modelCfg: ResolvedModelConfig | undefined,
): { provider: string; model: string } | null {
  if (!modelCfg) return null;
  // Explicit opt-in only: tier override first, then the configured fallback.
  const providerKey = modelCfg.tiers.consolidate ?? modelCfg.defaultProvider;
  if (!providerKey) return null;
  const block = modelCfg.providers[providerKey];
  if (!block?.model) return null;
  return { provider: providerKey, model: block.model };
}

/**
 * The consolidation capability gate — the SINGLE source of truth both
 * {@link buildMemoryEngine} and the daemon wiring (stdio/http) consult to decide
 * (a) whether the `memory_consolidate` MCP tool registers and (b) whether the
 * engine's `consolidate` can run. Returns the usable `{provider, model}` when
 * consolidation is ON, or `null` when it must be fully off.
 *
 * The gate is the AND of ALL three (blueprint D6 / §9 — NEVER a silent paid
 * call, the Agent-Memory anti-pattern):
 *  (a) `resolvedMemory.consolidation.enabled === true` — the user's EXPLICIT
 *      master switch under `memory:`. This is the LOAD-BEARING gate: a config
 *      with no `memory:` block (or `enabled:false`) resolves to `null`
 *      REGARDLESS of `model.defaultProvider`, so a `model:` block set for
 *      summarize/title/draft does NOT silently enable a paid consolidation call.
 *  (b) a usable provider+model — prefer the one named under `memory:` (with its
 *      own `model` id); fall back to the MODEL-derived derivation
 *      ({@link resolveMemoryConsolidation}) ONLY when the user enabled
 *      consolidation but did NOT name a provider under `memory:`.
 *  (c) the resolved pair has both a `provider` and a `model` id.
 *
 * `resolvedMemory` is the output of `resolveMemoryConfig(config.memory)` — the
 * pure core→memory bridge (no env inference, no cycle). Pure projection — reads
 * NO env, holds NO secrets, never throws. Whether the provider is actually
 * CALLABLE at runtime (key present, network up) is decided inside `complete()`
 * (S8) — here we only decide config-time capability.
 */
export function resolveConsolidationCapability(
  resolvedMemory: MemoryConfig | undefined,
  modelCfg: ResolvedModelConfig | undefined,
): { provider: string; model: string } | null {
  const cons = resolvedMemory?.consolidation;
  // (a) The master switch — load-bearing gate. Must be explicitly `true`; an
  // absent OR `false` block disables consolidation regardless of `model:`.
  // This is the line against the §9 "silent paid consolidation" leak: a
  // `model.defaultProvider:'anthropic'` set for summarize/title/draft must NOT
  // activate a paid memory consolidation call the user opted out of.
  if (cons?.enabled !== true) return null;
  // (b)+(c) Usable {provider, model}. Prefer the `memory:` block; fall back to
  // the model-derived derivation ONLY when no provider was named under `memory:`.
  if (cons.provider) {
    return cons.model ? { provider: cons.provider, model: cons.model } : null;
  }
  return resolveMemoryConsolidation(modelCfg);
}

/**
 * Adapt S8's {@link complete} (single-shot, provider-explicit) into the
 * {@link MemoryModel} shape the memory engine consumes. This is the ONLY LLM
 * entry point in the memory layer, and it is reached ONLY after the engine's
 * provider gate passes (DS-6: never a silent paid call). `null` degrades to the
 * engine's `model-unavailable` refusal; `{ok:false}` wraps as the same — both
 * are logged, neither crashes, neither is a surprise bill.
 *
 * Consolidation is free-text PROSE (not structured), so the `value`/`usage`
 * branches of {@link CompleteResult} are intentionally dropped here.
 */
function bindMemoryModel(modelCfg: ResolvedModelConfig): MemoryModel {
  return {
    async complete(req) {
      const result = await complete(
        {
          system: req.system,
          prompt: req.prompt,
          provider: req.provider,
          model: req.model,
          ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
          ...(req.tier !== undefined ? { tier: req.tier } : {}),
        },
        modelCfg,
      );
      if (result === null) return null;
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, text: result.text };
    },
  };
}

/**
 * Build the daemon's {@link MemoryEngine} from its already-open store handle +
 * the project `root` + `projectId` + the SAME `EmbedFn` the daemon resolved once
 * for S6 (the daemon owns one embedder; memory takes `{store, embed, ...}`, no
 * embedder duplication — plan §Architecture).
 *
 * One engine per serve lifecycle — constructed once alongside the store (see
 * {@link openStoreForDaemon}), the workflow engine (see
 * {@link buildWorkflowEngine}), and the context engine (see
 * {@link buildContextEngine}), and reused across every HTTP request, exactly as
 * those handles are. The engine — like the context indexer — is the ONLY thing
 * that writes `source:'memory'` rows through the injected handle; it never opens
 * a second connection, so the daemon's single-writer discipline is preserved
 * (blueprint D6: in-process, no sidecar, canonical `ProjectId`).
 *
 * Consolidation is OPT-IN + provider-explicit (DS-6 / §9 — NEVER a silent paid
 * call). The capability gate is {@link resolveConsolidationCapability} — the AND
 * of the user's `memory.consolidation.enabled` master switch (the load-bearing
 * gate), a usable provider+model (preferring the `memory:` block, falling back
 * to the model-derived derivation when enabled but no provider named under
 * `memory:`), and `modelCfg` being present to bind S8's `complete`. When the
 * gate resolves a `{provider, model}`:
 *   - S8's {@link complete} is bound as the engine's model injection, AND
 *   - the runtime gate `config.consolidation` is set so `consolidate` can run.
 * When the gate is `null` — most importantly when `enabled === false`, regardless
 * of `model.defaultProvider` — NO model is wired and `engine.consolidate`
 * self-refuses (`'no-provider'`) WITHOUT calling the model. The daemon registers
 * the `memory_consolidate` MCP tool only in the capable case.
 *
 * `resolvedMemory` is the output of `resolveMemoryConfig(config.memory)` — the
 * pure core→memory bridge. Passing it here means the engine's `config` reflects
 * the user's `memory:` consent exactly (never a hardcoded `enabled:true`).
 *
 * Degraded story (mirrors the store + the context engine): pass the store's
 * `storeDegraded` flag so the engine's persistent `degraded` field is honest —
 * `memory_save` / `memory_forget` then refuse with a clear envelope (the engine
 * throws upfront on a read-only handle) while reads (`memory_recall` /
 * `memory_search` / `memory_sessions`) keep working off the same handle.
 */
export function buildMemoryEngine(
  store: Store,
  root: string,
  projectId: ProjectId,
  embed: EmbedFn,
  modelCfg?: ResolvedModelConfig,
  storeDegraded?: boolean,
  resolvedMemory?: MemoryConfig,
): MemoryEngine {
  // Consolidation capability gate (DS-6 / §9). The AND of the user's master
  // switch + a usable provider+model. `null` ⇒ consolidation fully OFF: no model
  // wired, `memory_consolidate` not registered, and `engine.consolidate` refuses
  // `'no-provider'` WITHOUT a model call — regardless of `model.defaultProvider`.
  const cons = resolveConsolidationCapability(resolvedMemory, modelCfg);
  if (!cons) {
    // Pass resolvedMemory through so the engine's config reflects the user's
    // `memory:` block (enabled:false ⇒ runConsolidation refuses 'no-provider').
    return createMemoryEngine({
      store,
      root,
      projectId,
      embed,
      storeDegraded,
      ...(resolvedMemory ? { config: resolvedMemory } : {}),
    });
  }
  // Consolidation-capable. Bind S8 `complete` as the sole LLM entry point when
  // modelCfg is available; open the runtime gate so `consolidate` can run. If
  // modelCfg is absent (provider named under `memory:` but no `model:` block to
  // bind S8), the model stays unset and `consolidate` refuses `model-unavailable`.
  const model = modelCfg ? bindMemoryModel(modelCfg) : undefined;
  const config: MemoryConfig = {
    consolidation: { enabled: true, provider: cons.provider, model: cons.model },
  };
  return createMemoryEngine({
    store,
    root,
    projectId,
    embed,
    ...(model ? { model } : {}),
    config,
    storeDegraded,
  });
}
