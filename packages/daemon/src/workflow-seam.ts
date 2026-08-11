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
 * Map the user-facing `NoirConfig.prd.mandatoryFor` to the engine's
 * {@link WorkflowGateConfig}. The two `TaskClass` enums are duplicated literals
 * (core's `z.enum` and workflow's `TASK_CLASSES`) kept in sync by a literal-sync
 * test; this resolver is the single bridge so a user override actually reaches
 * the engine. A `null`/absent `prd` block resolves to `undefined` so the engine
 * applies its own default (no surprise override).
 */
export function resolveGateConfig(config?: NoirConfig): WorkflowGateConfig | undefined {
  const mandatoryFor = config?.prd?.mandatoryFor;
  if (!mandatoryFor || mandatoryFor.length === 0) return undefined;
  // Runtime-assert the strings are valid TaskClasses (the duplicated-literal
  // invariant; a parse gap here would silently drop the override).
  const valid = new Set<string>(TASK_CLASSES);
  const filtered = mandatoryFor.filter((c) => valid.has(c)) as TaskClass[];
  if (filtered.length === 0) return undefined;
  return { prd: { mandatoryFor: filtered } };
}
