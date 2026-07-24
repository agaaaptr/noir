import { mkdirSync } from 'node:fs';
import { type ProjectId, paths } from '@noir-ai/core';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { exportMarkdown } from './markdown.js';
import { migrate } from './migrations.js';
import type {
  FtsHit,
  IndexDoc,
  OpenOptions,
  SearchFtOpts,
  Store,
  VecHit,
  VecOpts,
  VecUpsertMeta,
} from './types.js';

/** Internal row shape from the docs_fts JOIN docs query. */
interface FtsRow {
  id: string;
  source: string;
  meta: string | null;
  score: number;
  snippet: string;
}

/** Internal row shape from the vec0 kNN query. */
interface VecRow {
  id: string;
  source: string;
  distance: number;
}

/**
 * Open (or create) the project's embedded SQLite store at
 * `.noir/store/<projectId>.db`.
 *
 * `sqlite-vec` is loaded into every connection (read-safe) so kNN queries work
 * in both read-write and read-only modes. In read-write mode the schema is
 * migrated to the latest version, WAL journaling is enabled, and the `vec0`
 * virtual table (deferred from v1 because `vec0` requires the extension
 * loaded) is created. In read-only mode none of those writes happen; callers
 * get a best-effort read handle against whatever schema already exists on
 * disk — kNN works if the `vec` table was created by a prior read-write open,
 * otherwise queries fail clearly against the missing table.
 *
 * `__db` is exposed for tests to assert schema state directly.
 */
export async function openStore(opts: OpenOptions): Promise<Store & { __db: Database.Database }> {
  const projectId: ProjectId = opts.projectId;
  const dbPath = paths.storeDb(opts.root, projectId);
  if (opts.readonly !== true) {
    mkdirSync(paths.storeDir(opts.root), { recursive: true });
  }

  const db = new Database(dbPath, { readonly: opts.readonly === true });

  // Load sqlite-vec first (read-safe; needed for kNN in either mode).
  sqliteVec.load(db);

  if (opts.readonly !== true) {
    db.pragma('journal_mode = WAL');
    migrate(db);
    // vec0 DDL deferred from v1: vec0 requires the sqlite-vec extension to be
    // loaded (done above). `source`/`id` are metadata columns — filterable in
    // kNN (`source = ?`) and deletable for idempotent upsert (`id = ?`). vec0
    // keys on rowid (auto-assigned); there is no text primary key.
    db.exec(
      'CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(embedding float[384], source TEXT, id TEXT)',
    );
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

  const deleteDoc = (id: string): void => {
    if (readonly) {
      throw new Error('store is read-only (daemon down)');
    }
    // The docs_ad AFTER DELETE trigger replays the row into docs_fts as a
    // 'delete' command (external-content sync, see migrations.ts), keeping the
    // FTS index consistent — no manual docs_fts work needed here.
    db.prepare('DELETE FROM docs WHERE id = ?').run(id);
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

  const upsertVec = (id: string, vec: Float32Array, meta?: VecUpsertMeta): void => {
    if (readonly) {
      throw new Error('store is read-only (daemon down)');
    }
    // Account for Float32Array views (byteOffset/byteLength) so a subarray
    // binds exactly its own bytes, not the whole backing ArrayBuffer.
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    const source = meta?.source ?? 'default';
    // vec0 keys on rowid; `id` is a metadata column. Idempotent via
    // delete-by-id-then-insert (both are filterable metadata ops) in one txn.
    const upsert = db.transaction(() => {
      db.prepare('DELETE FROM vec WHERE id = ?').run(id);
      db.prepare('INSERT INTO vec(embedding, source, id) VALUES (?, ?, ?)').run(buf, source, id);
    });
    upsert();
  };

  const deleteVec = (id: string): void => {
    if (readonly) {
      throw new Error('store is read-only (daemon down)');
    }
    // vec0 keys on rowid; `id` is a filterable metadata column, so delete-by-id
    // is a plain metadata predicate (same one upsertVec uses for idempotency).
    db.prepare('DELETE FROM vec WHERE id = ?').run(id);
  };

  const knn = (vec: Float32Array, opts?: VecOpts): VecHit[] => {
    const limit = opts?.limit ?? 5;
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    // `MATCH ? AND k = ?` is the canonical vec0 kNN form (version-independent;
    // `ORDER BY distance` is ascending by default — nearest first). distance is
    // L2, so lower == more similar; we mirror it onto `score` to match the FTS
    // convention where lower bm25 == more relevant.
    const source = opts?.source;
    const sql = source
      ? 'SELECT id, source, distance FROM vec WHERE embedding MATCH ? AND k = ? AND source = ? ORDER BY distance'
      : 'SELECT id, source, distance FROM vec WHERE embedding MATCH ? AND k = ? ORDER BY distance';
    const rows = source
      ? (db.prepare(sql).all(buf, limit, source) as VecRow[])
      : (db.prepare(sql).all(buf, limit) as VecRow[]);
    return rows.map((r) => ({ id: r.id, source: r.source, score: r.distance }));
  };

  const countDocs = (): number =>
    (db.prepare('SELECT count(*) AS c FROM docs').get() as { c: number }).c;

  const countVecs = (): number =>
    (db.prepare('SELECT count(*) AS c FROM vec').get() as { c: number }).c;

  return {
    projectId,
    __db: db,
    getState,
    setState,
    indexDoc,
    deleteDoc,
    searchFt,
    upsertVec,
    deleteVec,
    knn,
    countDocs,
    countVecs,
    exportMarkdown: (dir: string) => exportMarkdown(db, dir),
    close: async () => {
      db.close();
    },
  };
}
