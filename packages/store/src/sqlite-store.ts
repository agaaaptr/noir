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

/** Hard cap on hits any single search/kNN call may materialize — the retriever
 *  budgets/trims results anyway, so a caller passing `limit: 1e9` must not make
 *  better-sqlite3 `.all()` build every row (with snippets + meta JSON) in memory
 *  before the trim happens. */
const MAX_HITS = 200;

/**
 * Escape a free-text user query into FTS5 literal-phrase syntax: split on
 * whitespace and wrap each term in double quotes (embedded quotes doubled), so
 * operator characters (`-` `*` `:` `(` `)` `NEAR` …) and bare boolean keywords
 * are treated as LITERAL text instead of FTS5 expression syntax. Every search
 * path funnels through `searchFt`, and every caller passes raw user text — no
 * caller builds structured FTS5 queries — so escaping here is safe and single.
 * An empty/whitespace-only input matches nothing (the caller's guards normally
 * short-circuit first). */
function ftsEscape(query: string): string {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '""'))
    .filter((t) => t.length > 0)
    .map((t) => `"${t}"`);
  // `""` is a valid empty FTS5 phrase that matches nothing — never throws.
  return terms.length > 0 ? terms.join(' ') : '""';
}

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

  // Load sqlite-vec (read-safe; needed for kNN in either mode) FAIL-SOFT: if the
  // platform native binary is absent/broken (the exact case `vecAvailability()`
  // probes for), we must NOT make the whole store — KV, FTS, workflow, memory —
  // unopenable. Record the flag, skip the vec0 DDL, and let vec operations throw
  // a clear "vec unavailable" error instead of crashing at open.
  let vecMissing = false;
  try {
    sqliteVec.load(db);
  } catch {
    vecMissing = true;
  }

  if (opts.readonly !== true) {
    db.pragma('journal_mode = WAL');
    // Defense-in-depth vs SQLITE_BUSY: better-sqlite3's default busy_timeout is
    // 0 (throw immediately on lock contention). WAL alone doesn't prevent BUSY
    // if a second writer ever opens the same .db (e.g. a stdio MCP server + a
    // stray `noir` CLI, or a daemon whose pid file is stale). 5s lets a racing
    // writer complete instead of throwing "database is locked" at a tool call.
    db.pragma('busy_timeout = 5000');
    migrate(db);
    // vec0 DDL deferred from v1: vec0 requires the sqlite-vec extension to be
    // loaded (done above). `source`/`id` are metadata columns — filterable in
    // kNN (`source = ?`) and deletable for idempotent upsert (`id = ?`). vec0
    // keys on rowid (auto-assigned); there is no text primary key.
    if (!vecMissing) {
      db.exec(
        'CREATE VIRTUAL TABLE IF NOT EXISTS vec USING vec0(embedding float[384], source TEXT, id TEXT)',
      );
    }
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
    // Clamp BOTH bounds: a huge limit must not materialize every row, and a
    // negative/NaN/0 limit must not reach SQLite (LIMIT -1 = no limit).
    const raw = opts?.limit ?? 10;
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_HITS) : 10;
    // bm25(): more negative = more relevant, so ORDER BY score ascending.
    // snippet(docs_fts, 0, ...): column 0 is `content`; 16-token window with
    // <<match>> markers — NEVER the full content (blueprint §9.2).
    const source = opts?.source;
    // Escape the raw query into literal phrases (see ftsEscape) so operator
    // chars in a user query are searched as text, not parsed as FTS5 syntax.
    const match = ftsEscape(query);
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
      ? (db.prepare(sql).all(match, source, limit) as FtsRow[])
      : (db.prepare(sql).all(match, limit) as FtsRow[]);
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
    if (vecMissing) {
      throw new Error('vec unavailable (sqlite-vec native module not loadable)');
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
    if (vecMissing) {
      throw new Error('vec unavailable (sqlite-vec native module not loadable)');
    }
    // vec0 keys on rowid; `id` is a filterable metadata column, so delete-by-id
    // is a plain metadata predicate (same one upsertVec uses for idempotency).
    db.prepare('DELETE FROM vec WHERE id = ?').run(id);
  };

  const knn = (vec: Float32Array, opts?: VecOpts): VecHit[] => {
    if (vecMissing) {
      throw new Error('vec unavailable (sqlite-vec native module not loadable)');
    }
    const raw = opts?.limit ?? 5;
    const limit = Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), MAX_HITS) : 5;
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

  const countVecs = (): number => {
    if (vecMissing) return 0;
    return (db.prepare('SELECT count(*) AS c FROM vec').get() as { c: number }).c;
  };

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
    exportMarkdown: (dir: string, conflict?: import('./markdown.js').MarkdownConflictOpts) =>
      exportMarkdown(db, dir, conflict),
    close: async () => {
      db.close();
    },
  };
}
