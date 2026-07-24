import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId, paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('openStore + migrations', () => {
  it('creates the DB at .noir/store/<projectId>.db and runs v1', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const dbPath = paths.storeDb(root, id);
      expect(existsSync(dbPath)).toBe(true);
      // schema_version recorded
      const v = store.__db
        .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
        .get() as { version: number } | undefined;
      expect(v?.version).toBe(1);
      // kv table exists
      expect(() => store.__db.prepare('SELECT count(*) AS c FROM kv').get()).not.toThrow();
    } finally {
      await store.close();
    }
  });

  it('re-open is idempotent (does not re-apply v1)', async () => {
    await (await openStore({ projectId: id, root })).close();
    const store = await openStore({ projectId: id, root });
    try {
      const rows = store.__db.prepare('SELECT count(*) AS c FROM schema_version').get() as {
        c: number;
      };
      expect(rows.c).toBe(1); // only one v1 row
    } finally {
      await store.close();
    }
  });

  it('enables WAL journal mode', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const mode = store.__db.pragma('journal_mode', { simple: true });
      expect(mode).toBe('wal');
    } finally {
      await store.close();
    }
  });

  it('creates docs + docs_fts tables and sync triggers', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const db = store.__db;
      // docs table writable + FTS kept in sync
      db.prepare('INSERT INTO docs(id, source, content) VALUES (?, ?, ?)').run(
        'd1',
        'test',
        'hello world',
      );
      const hit = db.prepare('SELECT content FROM docs_fts WHERE docs_fts MATCH ?').get('hello') as
        | { content: string }
        | undefined;
      expect(hit?.content).toBe('hello world');
      // T4: sqlite-vec is loaded in openStore and the vec0 virtual table is
      // created in read-write mode (deferred from v1 because vec0 needs the
      // extension loaded).
      const vecTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec'")
        .get();
      expect(vecTable).toBeDefined();
    } finally {
      await store.close();
    }
  });
});
