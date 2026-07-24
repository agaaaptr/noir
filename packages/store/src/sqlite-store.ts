import { mkdirSync } from 'node:fs';
import { type ProjectId, paths } from '@noir-ai/core';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';
import type { OpenOptions, Store } from './types.js';

/**
 * Open (or create) the project's embedded SQLite store at
 * `.noir/store/<projectId>.db`.
 *
 * In read-write mode the schema is migrated to the latest version and WAL
 * journaling is enabled. In read-only mode neither migrations nor the WAL
 * pragma are applied (both require write access); callers get a best-effort
 * read handle against whatever schema already exists on disk.
 *
 * `__db` is exposed for tests to assert schema state directly; the public
 * `Store` API (kv/search/vec methods) is added in later tasks.
 */
export async function openStore(opts: OpenOptions): Promise<Store & { __db: Database.Database }> {
  const projectId: ProjectId = opts.projectId;
  const dbPath = paths.storeDb(opts.root, projectId);
  mkdirSync(paths.storeDir(opts.root), { recursive: true });

  const db = new Database(dbPath, { readonly: opts.readonly === true });

  if (opts.readonly !== true) {
    db.pragma('journal_mode = WAL');
    migrate(db);
  }
  // read-only: do not write. If the schema is missing, queries simply fail —
  // acceptable for degraded reads (e.g. inspecting a foreign DB).

  return {
    projectId,
    __db: db,
    close: async () => {
      db.close();
    },
  };
}
