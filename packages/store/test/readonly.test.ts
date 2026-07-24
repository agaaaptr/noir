/**
 * Read-only mode integration test (FS-fallback story).
 *
 * Proves that a store opened read-only against an existing DB can read all
 * data types (KV, FTS, vec) but rejects all writes. This is the degraded-read
 * fallback path used when the daemon is down and CLI tools need to inspect
 * the local store directly.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

// 384-dim test vector (same as vec.test.ts).
const DIM = 384;
function vec(entries: Array<[number, number]>): Float32Array {
  const v = new Float32Array(DIM);
  for (const [idx, val] of entries) v[idx] = val;
  return v;
}
const BASE = vec([[0, 1]]);
const NEAR1 = vec([
  [0, 0.99],
  [1, 0.01],
]);

// CI gate: sqlite-vec native binary must be available for vec tests.
const VEC_PROBE: { ok: true } | { ok: false; reason: string } = (() => {
  try {
    const probe = new Database(':memory:');
    sqliteVec.load(probe);
    probe.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
})();

const describeVec = VEC_PROBE.ok ? describe : describe.skip;
const describeLabel = VEC_PROBE.ok
  ? 'read-only mode (FS-fallback integration test)'
  : `read-only mode (SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason})`;

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-readonly-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describeVec(describeLabel, () => {
  it('reads all data types in read-only mode; all writes throw', async () => {
    // Step 1: Open writable and populate the DB with KV, FTS, and vec data.
    const writable = await openStore({ projectId: id, root });
    const testDoc = {
      id: 'test-doc',
      source: 'spec',
      content: 'Noir is a discipline layer for agentic CLIs.',
      meta: { version: 1 },
    };
    const testKv = { phase: 'plan', steps: 3 };

    writable.indexDoc(testDoc);
    writable.upsertVec('test-vec', NEAR1, { source: 'spec' });
    writable.setState('workflow', testKv);
    await writable.close();

    // Step 2: Reopen the SAME db file read-only.
    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      // Step 3: Assert reads work — all data types are accessible.
      const kv = ro.getState<typeof testKv>('workflow');
      expect(kv).toEqual(testKv);

      const ftsHits = ro.searchFt('discipline');
      expect(ftsHits.length).toBeGreaterThan(0);
      expect(ftsHits[0]?.id).toBe('test-doc');
      expect(ftsHits[0]?.meta).toEqual({ version: 1 });

      const vecHits = ro.knn(BASE, { limit: 1 });
      expect(vecHits.length).toBe(1);
      expect(vecHits[0]?.id).toBe('test-vec');

      // Step 4: Assert all writes throw with the degraded-read message.
      expect(() => ro.setState('key', 'value')).toThrow('store is read-only (daemon down)');
      expect(() => ro.indexDoc({ id: 'x', source: 's', content: 'c' })).toThrow(
        'store is read-only (daemon down)',
      );
      expect(() => ro.deleteDoc('x')).toThrow('store is read-only (daemon down)');
      expect(() => ro.upsertVec('y', BASE)).toThrow('store is read-only (daemon down)');
      expect(() => ro.deleteVec('y')).toThrow('store is read-only (daemon down)');
    } finally {
      await ro.close();
    }
  });
});
