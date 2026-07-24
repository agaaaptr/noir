import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStore } from '../src/sqlite-store.js';

// CI gate: sqlite-vec ships a native binary per platform. Probe-load it ONCE
// synchronously at module load; if the binary is missing/broken on this host,
// skip the whole describe block with a label that carries the failure reason
// (so CI on an unsupported platform reports a clear skip, not a red build).
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
  ? 'vec0 vector store + kNN'
  : `vec0 vector store + kNN [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

// 384-dim deterministic fakes. vec() places values at sparse indices; the rest
// are zero. This makes distances deterministic and easy to reason about:
//   BASE=[1,0,...]  NEAR1=[0.99,0.01,0,...]  NEAR2=[0.9,0.1,0,...]  OUTLIER=[0,1,0,...]
// L2 from BASE: NEAR1≈0.01414  NEAR2≈0.14142  OUTLIER≈1.41421  (ascending = nearest first)
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
const NEAR2 = vec([
  [0, 0.9],
  [1, 0.1],
]);
const OUTLIER = vec([[1, 1]]);

let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-store-vec-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describeVec(describeLabel, () => {
  it('knn returns the k nearest vectors in ascending distance order', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.upsertVec('near1', NEAR1, { source: 'spec' });
      store.upsertVec('near2', NEAR2, { source: 'spec' });
      store.upsertVec('outlier', OUTLIER, { source: 'docs' });

      const hits = store.knn(BASE, { limit: 2 });

      expect(hits).toHaveLength(2);
      // nearest two are NEAR1 then NEAR2, in that order
      expect(hits[0]?.id).toBe('near1');
      expect(hits[1]?.id).toBe('near2');
      // ascending distance: each hit's score strictly < the next
      expect(hits[0].score).toBeLessThan(hits[1].score);
      // and the excluded outlier is strictly farther than both
      expect(hits[1].score).toBeLessThan(1.4);
    } finally {
      await store.close();
    }
  });

  it('opts.source filters to one source bucket (pre-KNN, not post)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // docs-side vector sits right next to BASE, spec-side vectors are far.
      // A post-filter kNN with small limit would miss the spec rows entirely;
      // vec0 metadata filtering is applied at scan time, so spec rows surface.
      // Distances from BASE are distinct (no ties): spec-a < spec-b.
      store.upsertVec('docs-close', BASE, { source: 'docs' });
      store.upsertVec('spec-a', vec([[50, 0.5]]), { source: 'spec' }); // dist sqrt(1.25)≈1.118
      store.upsertVec('spec-b', vec([[60, 1.0]]), { source: 'spec' }); // dist sqrt(2)≈1.414

      const specHits = store.knn(BASE, { limit: 2, source: 'spec' });
      expect(specHits).toHaveLength(2);
      expect(specHits.every((h) => h.source === 'spec')).toBe(true);
      expect(specHits.map((h) => h.id)).toEqual(['spec-a', 'spec-b']);
    } finally {
      await store.close();
    }
  });

  it('upsert is idempotent — re-upserting the same id does not duplicate', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      store.upsertVec('d', NEAR1);
      // re-upsert same id with a DIFFERENT vector (moves it to the outlier)
      store.upsertVec('d', OUTLIER);

      const count = store.__db.prepare("SELECT count(*) AS c FROM vec WHERE id = 'd'").get() as {
        c: number;
      };
      expect(count.c).toBe(1);

      // and the NEW embedding is what kNN sees: querying OUTLIER space returns d at distance ~0
      const hits = store.knn(OUTLIER, { limit: 1 });
      expect(hits[0]?.id).toBe('d');
      expect(hits[0]?.score).toBeLessThan(0.001);
    } finally {
      await store.close();
    }
  });

  it('upsertVec throws in read-only mode; knn still works (read is allowed)', async () => {
    // read-write open creates the vec table on disk; reopen read-only.
    await (await openStore({ projectId: id, root })).close();
    const store = await openStore({ projectId: id, root, readonly: true });
    try {
      expect(() => store.upsertVec('x', BASE)).toThrow('store is read-only (daemon down)');
    } finally {
      await store.close();
    }
  });

  it('knn works in read-only mode against a vec table created by a prior writable open', async () => {
    const writable = await openStore({ projectId: id, root });
    writable.upsertVec('near1', NEAR1, { source: 'spec' });
    writable.upsertVec('near2', NEAR2, { source: 'spec' });
    await writable.close();

    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const hits = ro.knn(BASE, { limit: 2 });
      expect(hits).toHaveLength(2);
      expect(hits.map((h) => h.id)).toEqual(['near1', 'near2']);
    } finally {
      await ro.close();
    }
  });
});
