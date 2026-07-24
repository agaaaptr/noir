import type { ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';

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
 */
export function buildWorkflowEngine(
  store: Store,
  root: string,
  projectId: ProjectId,
): WorkflowEngine {
  return new WorkflowEngine(store, root, projectId);
}
