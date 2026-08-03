import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStoreStatus, createNoirServer } from '../src/server.js';
import { openStoreForDaemon } from '../src/store-seam.js';

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-status-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'store-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/** 384-dim unit vector (sqlite-vec requires float[384]). */
const VEC = new Float32Array(384).fill(0);

describe('store_status', () => {
  it('returns ok:true with accurate doc/vec counts, projectId, and dbPath over MCP', async () => {
    // Seed the store: one doc + one vec. The daemon is the single writer, so
    // we open writable just like the seam does.
    const store = await openStore({ projectId: id, root });
    try {
      store.indexDoc({ id: 'd1', source: 'spec', content: 'Noir toolkit design' });
      store.upsertVec('v1', VEC);

      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: false,
      });

      // In-process MCP round-trip: no HTTP, no stdio — just a linked transport
      // pair. Confirms the tool is registered under the right name + schema and
      // that the handler returns the live counts.
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client(
        { name: 'noir-test', version: '0.0.0' },
        { versionNegotiation: { mode: 'auto' } },
      );
      await client.connect(clientTransport);

      const result = await client.callTool({ name: 'store_status', arguments: {} });
      const block = result.content?.[0];
      const parsed = JSON.parse((block as { text: string }).text);

      expect(parsed).toEqual({
        ok: true,
        projectId: id,
        docCount: 1,
        vecCount: 1,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        degraded: false,
      });
      await client.close();
    } finally {
      await store.close();
    }
  });

  it('reflects fresh data immediately — counts track indexDoc/upsertVec', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const dbPath = join(root, '.noir', 'store', `${id}.db`);

      // Empty store: zero counts.
      expect(buildStoreStatus(store, dbPath, false)).toMatchObject({ docCount: 0, vecCount: 0 });

      store.indexDoc({ id: 'd1', source: 'spec', content: 'one' });
      store.indexDoc({ id: 'd2', source: 'spec', content: 'two three' });
      store.upsertVec('v1', VEC);

      // Live read from the same handle — no caching.
      expect(buildStoreStatus(store, dbPath, false)).toMatchObject({ docCount: 2, vecCount: 1 });
    } finally {
      await store.close();
    }
  });

  it('reports accurate counts from a read-only (degraded) handle', async () => {
    // Writable open creates the schema + seeds one doc/vec, then we reopen
    // read-only — the exact shape the daemon's degraded path uses.
    const seed = await openStore({ projectId: id, root });
    seed.indexDoc({ id: 'd1', source: 'spec', content: 'seeded' });
    seed.upsertVec('v1', VEC);
    await seed.close();

    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const dbPath = join(root, '.noir', 'store', `${id}.db`);
      const status = buildStoreStatus(ro, dbPath, true);
      expect(status).toEqual({
        ok: true,
        projectId: id,
        docCount: 1,
        vecCount: 1,
        dbPath,
        degraded: true,
      });
    } finally {
      await ro.close();
    }
  });
});

describe('openStoreForDaemon', () => {
  it('opens writable by default and reports degraded:false', async () => {
    const { store, dbPath, degraded } = await openStoreForDaemon(id, root);
    try {
      expect(degraded).toBe(false);
      expect(dbPath).toBe(join(root, '.noir', 'store', `${id}.db`));
      // Writable handle — indexDoc must succeed (proves single-writer path).
      store.indexDoc({ id: 'd1', source: 'spec', content: 'writable' });
      expect(buildStoreStatus(store, dbPath, degraded).docCount).toBe(1);
    } finally {
      await store.close();
    }
  });

  // `chmodSync(dir, 0o555)` cannot make a directory unwritable on Windows:
  // Node translates it to the DOS read-only attribute, which does NOT prevent
  // file creation inside the directory (Windows ACLs gate that, not the mode
  // bits). The degraded-path assertion would therefore fail on Windows, so
  // the test is POSIX-only. The degraded CODE PATH itself is cross-platform —
  // a genuinely-unwritable Windows dir (ACL-denied) still triggers it.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  itPosix('falls back to read-only (degraded:true) when the writable open fails', async () => {
    // Seed an existing DB so the read-only fallback has data to report.
    const seed = await openStore({ projectId: id, root });
    seed.indexDoc({ id: 'd1', source: 'spec', content: 'seeded' });
    // Switch off WAL: the read-only reopen then needs no -wal/-shm sidecars,
    // so it can still read once we make the store dir unwritable below. (With
    // WAL on, a read-only reopen in an unwritable dir can't attach the WAL.)
    seed.__db.pragma('journal_mode = DELETE');
    await seed.close();

    // Make the STORE DIR read-only. SQLite's writable open then can't create
    // the WAL sidecar, so `pragma('journal_mode = WAL')` in the writable path
    // throws; the read-only path (no WAL) opens and reads fine. Mirrors the
    // real degraded trigger: the DB exists but can't be opened for writes.
    const storeDir = join(root, '.noir', 'store');
    const dbFile = join(storeDir, `${id}.db`);
    chmodSync(storeDir, 0o555);

    const { store, degraded } = await openStoreForDaemon(id, root);
    try {
      expect(degraded).toBe(true);
      // Read-only handle still reports accurate counts — the degraded promise.
      expect(buildStoreStatus(store, dbFile, degraded).docCount).toBe(1);
    } finally {
      await store.close();
      chmodSync(storeDir, 0o755);
    }
  });
});
