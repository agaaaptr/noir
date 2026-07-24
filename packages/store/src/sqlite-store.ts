import { mkdirSync } from 'node:fs';
import { type ProjectId, paths } from '@noir-ai/core';
import Database from 'better-sqlite3';
import { migrate } from './migrations.js';
import type { FtsHit, IndexDoc, OpenOptions, SearchFtOpts, Store } from './types.js';

/** Internal row shape from the docs_fts JOIN docs query. */
interface FtsRow {
  id: string;
  source: string;
  meta: string | null;
  score: number;
  snippet: string;
}

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

  const readonly = opts.readonly === true;

  const getState = <T>(key: string): T | null => {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row ? (JSON.parse(row.value) as T) : null;
  };

  const setState = <T>(key: string, value: T): void => {
    if (readonly) {
      throw new Error('store is read-only (daemon down)');
    }
    db.prepare(
      'INSERT INTO kv(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, JSON.stringify(value));
  };

  const indexDoc = (doc: IndexDoc): void => {
    if (readonly) {
      throw new Error('store is read-only (daemon down)');
    }
    // Upsert into docs; the docs_ai/docs_au triggers keep docs_fts in sync.
    db.prepare(
      'INSERT INTO docs(id, source, content, meta) VALUES(?, ?, ?, ?) ' +
        'ON CONFLICT(id) DO UPDATE SET source=excluded.source, content=excluded.content, meta=excluded.meta',
    ).run(doc.id, doc.source, doc.content, doc.meta ? JSON.stringify(doc.meta) : null);
  };

  const searchFt = (query: string, opts?: SearchFtOpts): FtsHit[] => {
    const limit = opts?.limit ?? 10;
    // bm25(): more negative = more relevant, so ORDER BY score ascending.
    // snippet(docs_fts, 0, ...): column 0 is `content`; 16-token window with
    // <<match>> markers — NEVER the full content (blueprint §9.2).
    const source = opts?.source;
    const sql = source
      ? `SELECT d.id AS id, d.source AS source, d.meta AS meta, bm25(docs_fts) AS score,
                snippet(docs_fts, 0, '<<', '>>', '…', 16) AS snippet
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ? AND d.source = ?
         ORDER BY score LIMIT ?`
      : `SELECT d.id AS id, d.source AS source, d.meta AS meta, bm25(docs_fts) AS score,
                snippet(docs_fts, 0, '<<', '>>', '…', 16) AS snippet
         FROM docs_fts JOIN docs d ON d.rowid = docs_fts.rowid
         WHERE docs_fts MATCH ?
         ORDER BY score LIMIT ?`;
    const rows = source
      ? (db.prepare(sql).all(query, source, limit) as FtsRow[])
      : (db.prepare(sql).all(query, limit) as FtsRow[]);
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      score: r.score,
      snippet: r.snippet,
      ...(r.meta ? { meta: JSON.parse(r.meta) } : {}),
    }));
  };

  return {
    projectId,
    __db: db,
    getState,
    setState,
    indexDoc,
    searchFt,
    close: async () => {
      db.close();
    },
  };
}
