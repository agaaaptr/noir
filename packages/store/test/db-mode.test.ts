/**
 * Owner-only permissions on the embedded store.
 *
 * The database holds the project's whole indexed context — document text, the
 * full-text index, embeddings — plus its memories: content no other account on
 * the machine has any business reading. It used to land at the process's umask
 * default (0644) inside a directory created the same way (0755), because SQLite
 * creates the file itself and takes no creation mode.
 *
 * This suite pins the fixed contract: a fresh open leaves the database 0600 and
 * its directory 0700, a database or directory an older Noir left lax is healed
 * on the next open, and a read-only open changes nothing on disk.
 *
 * Offline/free: no network, no API key, no embedder.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId, paths } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

/** Windows permissions are ACL-based, so a POSIX mode there asserts something
 *  the platform cannot express; the mode assertions are POSIX-only. */
const posixIt = it.skipIf(process.platform === 'win32');

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-db-mode-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const modeOf = (path: string): number => statSync(path).mode & 0o777;
const dbPath = (): string => paths.storeDb(root, id);
const storeDir = (): string => paths.storeDir(root);

/** Open the store writable and close it again — the state a previous `noir`
 *  run leaves on disk, which the tests below then widen by hand. */
async function seedStore(): Promise<void> {
  const store = await openStore({ projectId: id, root });
  await store.close();
}

describe('owner-only store database and directory', () => {
  posixIt('creates the database 0600 and its directory 0700 on a fresh open', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      expect(modeOf(dbPath())).toBe(0o600);
      expect(modeOf(storeDir())).toBe(0o700);
    } finally {
      await store.close();
    }
  });

  posixIt('heals an existing 0644 database to 0600 on the next open', async () => {
    await seedStore();
    chmodSync(dbPath(), 0o644); // the state the audit found

    const store = await openStore({ projectId: id, root });
    try {
      expect(modeOf(dbPath())).toBe(0o600);
    } finally {
      await store.close();
    }
  });

  posixIt('heals a 0640 database too — group read access is another account reading', async () => {
    await seedStore();
    chmodSync(dbPath(), 0o640);

    const store = await openStore({ projectId: id, root });
    try {
      expect(modeOf(dbPath())).toBe(0o600);
    } finally {
      await store.close();
    }
  });

  posixIt('narrows a 0755 store directory left by an older Noir to 0700', async () => {
    await seedStore();
    chmodSync(storeDir(), 0o755);

    const store = await openStore({ projectId: id, root });
    try {
      expect(modeOf(storeDir())).toBe(0o700);
    } finally {
      await store.close();
    }
  });

  posixIt('keeps the WAL sidecar files owner-only while the store is open', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.setState('touched', 1); // force the write-ahead log to exist
      const sidecars = ['-wal', '-shm']
        .map((suffix) => `${dbPath()}${suffix}`)
        .filter((path) => existsSync(path));
      // Both are created by SQLite while the connection is open and carry
      // database pages; SQLite removes them again on a clean close.
      expect(sidecars.length).toBeGreaterThan(0);
      for (const sidecar of sidecars) expect(modeOf(sidecar)).toBe(0o600);
    } finally {
      await store.close();
    }
  });

  posixIt('does not touch the database mode on a read-only open', async () => {
    await seedStore();
    chmodSync(dbPath(), 0o644);

    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      // A read-only handle reads; it never repairs. Healing here would mean a
      // "degraded, daemon is down" read mutating the filesystem it was only
      // asked to inspect.
      expect(modeOf(dbPath())).toBe(0o644);
    } finally {
      await store.close();
    }
  });

  posixIt(
    'strips group/other access without handing the owner access it did not have',
    async () => {
      // A store directory the operator has deliberately made read-only — an
      // archived copy, a read-only mount — must not be flipped back to writable
      // by the heal: only group/other bits are cleared, and the owner's own bits
      // survive exactly as they were. The writable open then still fails (no
      // sidecar can be created in a directory without write permission), which is
      // the pre-existing contract for an unwritable store directory.
      await seedStore();
      chmodSync(storeDir(), 0o555);
      try {
        await expect(openStore({ projectId: id, root })).rejects.toThrow();
        expect(modeOf(storeDir())).toBe(0o500);
      } finally {
        chmodSync(storeDir(), 0o755); // restore write access so cleanup can remove the tree
      }
    },
  );
});
