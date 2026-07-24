import { type ProjectId, paths } from '@noir-ai/core';
import { openStore, type Store } from '@noir-ai/store';

/**
 * A store handle opened by the daemon for its own lifecycle.
 *
 * - `store` — the single writer/reader handle (the daemon is the only writer).
 * - `dbPath` — absolute path to `<root>/.noir/store/<projectId>.db`; reported by
 *   `store_status`.
 * - `degraded` — `true` when the writable open failed and we fell back to a
 *   read-only handle. In degraded mode writes throw
 *   `"store is read-only (daemon down)"`, but reads (FTS, kNN, counts) keep
 *   working, so the MCP surface still reports accurate state.
 */
export interface DaemonStore {
  store: Store;
  dbPath: string;
  degraded: boolean;
}

/**
 * Open the project's store for the daemon — the single writer.
 *
 * Tries a read-write open first (creating the DB + migrating schema if
 * needed). On any failure (DB locked by another writer, permissions, transient
 * FS error) it falls back to a read-only open so the daemon still has an
 * accurate read handle — the FS-fallback / degraded story. The caller threads
 * `degraded` into `ServerContext` so `store_status` can surface it.
 */
export async function openStoreForDaemon(projectId: ProjectId, root: string): Promise<DaemonStore> {
  const dbPath = paths.storeDb(root, projectId);
  try {
    const store = await openStore({ projectId, root });
    return { store, dbPath, degraded: false };
  } catch {
    // FS-fallback: read-only. If the DB file doesn't exist yet this will also
    // throw; that propagates to the caller, which treats "no store" as
    // "omit the tool" rather than crashing the daemon.
    const store = await openStore({ projectId, root, readonly: true });
    return { store, dbPath, degraded: true };
  }
}
