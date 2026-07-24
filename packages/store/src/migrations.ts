import type Database from 'better-sqlite3';

/**
 * Schema v1.
 *
 * NOTE on packaging: the v1 SQL is inlined here as a TS string (rather than
 * shipped as a separate `sql/v1.sql` resolved via `import.meta.url`) because
 * the installed tsup (8.5.1) exposes no `copy: { items: [...] }` option, only
 * `publicDir`. Inlining avoids all file-resolution concerns across src/dist and
 * keeps the schema the single source of truth right next to the runner.
 *
 * NOTE on `vec`: the `vec0` virtual table requires the `sqlite-vec` extension
 * to be loaded into the connection, which T1 does NOT do. Its DDL is therefore
 * intentionally omitted from v1 and will be added in T4 (via a v2 migration or
 * a load-time create once `sqliteVec.load(db)` runs).
 */
const V1_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  content,
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- keep docs_fts in sync with docs
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO docs_fts(rowid, content) VALUES (new.rowid, new.content);
END;
`;

interface Migration {
  version: number;
  sql: string;
}

/** Ordered migrations. v1 is the initial schema. */
const migrations: Migration[] = [{ version: 1, sql: V1_SQL }];

/**
 * Hand-rolled versioned-SQL migration runner.
 *
 * Idempotent: tracks applied versions in a `schema_version` table and only runs
 * each migration once. Each migration is applied in its own transaction; on
 * failure the transaction is rolled back and the error re-thrown.
 */
export function migrate(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);');

  const applied = new Set(
    db
      .prepare('SELECT version FROM schema_version')
      .all()
      .map((r) => (r as { version: number }).version),
  );

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version(version) VALUES (?)').run(m.version);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
