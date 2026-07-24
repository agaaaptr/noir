import { ContextEngine, type EmbedderConfig } from '@noir-ai/context';
import type { ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';

/**
 * Build the daemon's {@link ContextEngine} from its already-open store handle
 * + the project `root` + `projectId` + a resolved {@link EmbedderConfig}.
 *
 * One engine per serve lifecycle — constructed once alongside the store (see
 * {@link openStoreForDaemon}) and the workflow engine (see
 * {@link buildWorkflowEngine}), and reused across every HTTP request, exactly
 * as those handles are. The engine resolves its embedder once (a lazy local
 * model loads at most once per lifecycle) and then owns the indexer (the only
 * context writer) + the retriever (the only context reader) over the SAME
 * injected handle — it never opens a second connection, so the daemon's
 * single-writer discipline is preserved (blueprint D6: in-process, no sidecar,
 * canonical `ProjectId`).
 *
 * Degraded story (mirrors the store + the engine's own contract): pass the
 * store's `storeDegraded` flag so the engine's persistent `degraded` field is
 * honest — `context_status` then reports `degraded:true` for a read-only
 * (daemon-down) handle, and `context_index` short-circuits with a clear error
 * envelope instead of letting the first write throw mid-run. A `kind:'none'`
 * embedder on a WRITABLE store is NOT blocking here: docs still index without
 * vectors (the indexer's tested degraded path), so only the read-only case is
 * fenced off at the tool boundary.
 */
export function buildContextEngine(
  store: Store,
  root: string,
  projectId: ProjectId,
  embedderCfg: EmbedderConfig,
  storeDegraded?: boolean,
): ContextEngine {
  return new ContextEngine({ store, root, projectId, embedderCfg, storeDegraded });
}
