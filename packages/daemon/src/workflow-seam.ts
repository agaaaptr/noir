import type { NoirConfig, ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import {
  TASK_CLASSES,
  type TaskClass,
  WorkflowEngine,
  type WorkflowGateConfig,
} from '@noir-ai/workflow';

/**
 * Build the daemon's {@link WorkflowEngine} from its already-open store handle
 * + the project `root` + `projectId`.
 *
 * One engine per serve lifecycle — constructed once alongside the store (see
 * {@link openStoreForDaemon}) and reused across every HTTP request, exactly as
 * the store handle is. The engine is a thin orchestrator over the store KV, so
 * it inherits the daemon's single-writer discipline for free.
 *
 * Degraded story: the engine itself is mode-agnostic; when the underlying store
 * was opened read-only (`storeDegraded === true`), `workflow_status` still works
 * (a pure KV read via {@link Store.getState}) while `checkpoint { action:'save' }`
 * throws `"store is read-only (daemon down)"` — the tool handler catches that and
 * surfaces a clear JSON error instead of crashing the daemon.
 *
 * Gate-config bridge (c4-surface-wiring S5): the optional `gateConfig` resolves
 * the user's `NoirConfig.prd.mandatoryFor` override into the engine. When omitted,
 * the engine falls back to its own default (feature/epic). The daemon construction
 * sites pass {@link resolveGateConfig}; the CLI's in-process read path passes the
 * same shape so degraded reads match the daemon path.
 */
export function buildWorkflowEngine(
  store: Store,
  root: string,
  projectId: ProjectId,
  gateConfig?: WorkflowGateConfig,
): WorkflowEngine {
  return new WorkflowEngine(store, root, projectId, gateConfig);
}

/**
 * Map the user-facing `NoirConfig` gate blocks to the engine's
 * {@link WorkflowGateConfig}. The two `TaskClass` enums are duplicated literals
 * (core's `z.enum` and workflow's `TASK_CLASSES`) kept in sync by a literal-sync
 * test; this resolver is the single bridge so user overrides actually reach the
 * engine. Resolves the `prd.mandatoryFor` override (c4-surface-wiring S5) and
 * the `workflow.gate.verify` evidence-gate config (c4-verify-gate-recovery S4).
 * Returns `undefined` only when BOTH blocks are at their defaults — otherwise the
 * engine always receives an explicit shape (no surprise default merge).
 */
export function resolveGateConfig(config?: NoirConfig): WorkflowGateConfig | undefined {
  const valid = new Set<string>(TASK_CLASSES);
  // PRD slice.
  const mandatoryForRaw = config?.prd?.mandatoryFor;
  const mandatoryFor = (mandatoryForRaw ?? [])
    .filter((c) => valid.has(c))
    .map((c) => c as TaskClass);
  // Verify slice — pass through the user's shape (the engine applies it).
  const verifyCfg = config?.workflow?.gate?.verify;
  const hasVerify = verifyCfg !== undefined;
  const prdAtDefault =
    mandatoryFor.length === 0 ||
    (mandatoryFor.length === 2 &&
      mandatoryFor.includes('feature') &&
      mandatoryFor.includes('epic'));
  const verifyAtDefault = !hasVerify || verifyCfg.required === false;
  if (prdAtDefault && verifyAtDefault) return undefined;
  return {
    prd: mandatoryFor.length === 0 ? { mandatoryFor: ['feature', 'epic'] } : { mandatoryFor },
    verify: hasVerify
      ? {
          required: verifyCfg.required,
          retryBudget: verifyCfg.retryBudget ?? 2,
          ...(verifyCfg.checks === undefined ? {} : { checks: verifyCfg.checks }),
        }
      : { required: false, retryBudget: 2 },
  };
}
