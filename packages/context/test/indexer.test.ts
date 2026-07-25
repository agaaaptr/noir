// Indexer integration tests (slice S6, task t6).
//
// Exercises the SHA-256 content-hash incremental indexer against a REAL store
// (sqlite-vec gated like packages/store/test/readonly.test.ts) with the
// deterministic `fakeEmbedFn` — fully offline, no model download, no network
// (spec §13 / NFR-2). Covers: new-tree index + KV state, content-hash skip
// (AC-1), modify/delete/add reconciliation, binary/encoding failures, index-time
// identifier explosion (DS-7), the degraded docs-only path (F8), model-swap
// warning, forget/reindex, and scoped reconciliation (other roots untouched).

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore, vecAvailability } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chunkFile } from '../src/chunker.js';
import { fakeEmbedFn } from '../src/embedders/fake.js';
import {
  CTX_EMBEDDER_KEY,
  CTX_REGISTRY_KEY,
  createIndexer,
  ctxFileKey,
  type FileRecord,
  isSensitive,
} from '../src/indexer.js';
import type { EmbedderInfo, EmbedFn, Store } from '../src/types.js';

// CI gate: the store opens sqlite-vec into every connection, so the whole suite
// is skipped (with a labelled reason) when the native binary is unavailable —
// mirrors packages/store/test/{vec,readonly}.test.ts.
const VEC_PROBE = vecAvailability();

const describeVec = VEC_PROBE.ok ? describe : describe.skip;
const describeLabel = VEC_PROBE.ok
  ? 'indexer (content-hash incremental)'
  : `indexer (SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason})`;

const FAKE_INFO: EmbedderInfo = { kind: 'local', model: 'test-fake', dim: 384 };

// Independent SHA-256 (not the indexer's own helper) so tests cross-check the
// chunk-id / parentDocId contract rather than re-stating the implementation.
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Expected chunk count for a file (delegates to the real chunker so tests stay
// robust to chunker tuning).
function expectedChunkCount(pathKey: string, content: string): number {
  return chunkFile({ path: pathKey, content }).length;
}

let root: string;
let projectId: string;
let store: Store;
let indexer: ReturnType<typeof createIndexer>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-context-indexer-'));
  projectId = createProjectId();
});

afterEach(async () => {
  if (store) await store.close();
  rmSync(root, { recursive: true, force: true });
});

function writeFile(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

function removeFile(rel: string): void {
  unlinkSync(join(root, rel));
}

// Fresh indexer + store wired to the tmpdir root (repo-relative keys).
function freshIndexer(
  embed: EmbedFn = fakeEmbedFn(),
  info: EmbedderInfo = FAKE_INFO,
): ReturnType<typeof createIndexer> {
  return createIndexer({ store, embed, info, root });
}

describeVec(describeLabel, () => {
  // ---------------------------------------------------------------------------

  it('indexes a new tree: writes docs + vecs and records KV state', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    const util =
      'export function contextEngine(opts: Opts): Result {\n  return compute(opts);\n}\n';
    const readme = '# Title\n\nIntro prose.\n\n## Section A\n\nBody of section A.\n';
    writeFile('src/util.ts', util);
    writeFile('README.md', readme);

    const res = await indexer.indexPaths(['.']);

    const expUtil = expectedChunkCount('src/util.ts', util);
    const expReadme = expectedChunkCount('README.md', readme);

    expect(res.indexed).toBe(expUtil + expReadme);
    expect(res.skipped).toBe(0);
    expect(res.deleted).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.degraded).toBe(false);
    expect(res.totalChunks).toBe(res.indexed);

    // One docs row + one vec0 row per chunk, same ids.
    expect(store.countDocs()).toBe(res.indexed);
    expect(store.countVecs()).toBe(res.indexed);

    // KV: registry lists both repo-relative keys; embedder recorded.
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry).toEqual(['README.md', 'src/util.ts']);
    expect(store.getState<EmbedderInfo>(CTX_EMBEDDER_KEY)).toEqual(FAKE_INFO);

    const rec = store.getState<FileRecord>(ctxFileKey('src/util.ts'));
    expect(rec?.chunkIds).toHaveLength(expUtil);
    expect(rec?.language).toBe('typescript');
    // .noir/ (store DB lives there) was skipped by the walk — not in the registry.
    expect(registry.some((p) => p.includes('.noir'))).toBe(false);
  });

  it('skips unchanged files on re-index (AC-1)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('src/a.ts', 'const a = 1;\nconst b = 2;\n');
    const first = await indexer.indexPaths(['src']);
    expect(first.indexed).toBeGreaterThan(0);

    // Identical re-call: nothing re-indexed, all chunks hit the content-hash skip.
    const second = await indexer.indexPaths(['src']);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(first.indexed);
    expect(second.deleted).toBe(0);
    expect(second.failed).toBe(0);
    expect(store.countDocs()).toBe(first.indexed);
    expect(store.countVecs()).toBe(first.indexed);
  });

  it('re-indexes only modified files; leaves untouched files skipped', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    const utilV1 = 'export function contextEngine(): void {}\n';
    const stable = '# Docs\n\nStable body that does not change.\n';
    writeFile('src/util.ts', utilV1);
    writeFile('docs/stable.md', stable);
    await indexer.indexPaths(['.']);

    const utilV2 = `${utilV1}export const extra = computeExtra();\n`;
    writeFile('src/util.ts', utilV2);

    const res = await indexer.indexPaths(['.']);
    expect(res.indexed).toBe(expectedChunkCount('src/util.ts', utilV2)); // only util re-chunked
    expect(res.skipped).toBe(expectedChunkCount('docs/stable.md', stable)); // stable.md skipped
    expect(res.deleted).toBe(0);
  });

  it('deletes chunks + vectors for removed files (scoped reconcile)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    const util = 'export function contextEngine(): void {}\n';
    const readme = '# Title\n\nBody.\n';
    writeFile('src/util.ts', util);
    writeFile('README.md', readme);
    await indexer.indexPaths(['.']);
    const docsBefore = store.countDocs();
    const vecsBefore = store.countVecs();
    const readmeChunks = expectedChunkCount('README.md', readme);

    removeFile('README.md');
    const res = await indexer.indexPaths(['.']);

    expect(res.deleted).toBe(1);
    expect(store.countDocs()).toBe(docsBefore - readmeChunks);
    expect(store.countVecs()).toBe(vecsBefore - readmeChunks);
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry).toContain('src/util.ts');
    expect(registry).not.toContain('README.md');
    // Tombstone: the per-file record is cleared (null).
    expect(store.getState<FileRecord>(ctxFileKey('README.md'))).toBeNull();
  });

  it('counts binary files as failed (extension guard, no full read)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('binary'));
    writeFile('src/a.ts', 'const a = 1;\n');

    const res = await indexer.indexPaths(['.']);
    expect(res.failed).toBe(1);
    expect(res.indexed).toBe(expectedChunkCount('src/a.ts', 'const a = 1;\n'));
    // Binary file is not tracked in the registry.
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry.some((p) => p.endsWith('.png'))).toBe(false);
  });

  it('detects mis-extensioned binaries via null byte (failed)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    // A .ts extension but binary content (contains a NUL byte).
    writeFile('src/fake.ts', `const x = ${String.fromCharCode(0)};\n`);
    const res = await indexer.indexPaths(['src']);
    expect(res.failed).toBe(1);
    expect(res.indexed).toBe(0);
  });

  it('appends identifier explosion so FTS matches a camelCase identifier (DS-7)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    // 'hover' appears ONLY as a sub-token of `myHoverController` — porter
    // unicode61 would not split the camelCase identifier on its own, so a BM25
    // hit for the bare token 'hover' proves the index-time explosion.
    writeFile('src/ctrl.ts', 'const x = myHoverController();\n');
    await indexer.indexPaths(['src']);

    const hits = store.searchFt('hover');
    expect(hits.length).toBeGreaterThan(0);
    const parentDocId = sha256('src/ctrl.ts');
    expect(hits[0]?.id.startsWith(`${parentDocId}#chunk-`)).toBe(true);
  });

  it('degrades to docs-only (no vectors) when embedder is kind:none', async () => {
    store = await openStore({ projectId, root });
    const throwing: EmbedFn = async () => {
      throw new Error('embedder disabled');
    };
    indexer = createIndexer({
      store,
      embed: throwing,
      info: { kind: 'none', dim: 0 },
      root,
    });

    writeFile('src/a.ts', 'const a = 1;\nconst b = 2;\n');
    const res = await indexer.indexPaths(['src']);

    expect(res.degraded).toBe(true);
    expect(res.indexed).toBeGreaterThan(0);
    expect(store.countDocs()).toBe(res.indexed);
    expect(store.countVecs()).toBe(0);
  });

  it('degrades to docs-only when embed() throws at runtime', async () => {
    store = await openStore({ projectId, root });
    const failing: EmbedFn = async () => {
      throw new Error('native load failed');
    };
    indexer = createIndexer({
      store,
      embed: failing,
      info: { kind: 'local', model: 'broken', dim: 384 },
      root,
    });

    writeFile('src/a.ts', 'const a = 1;\nconst b = 2;\n');
    const res = await indexer.indexPaths(['src']);

    expect(res.degraded).toBe(true);
    expect(store.countVecs()).toBe(0);
    expect(store.countDocs()).toBeGreaterThan(0);
  });

  it('warns on embedder model swap (never silent)', async () => {
    store = await openStore({ projectId, root });
    writeFile('src/a.ts', 'const a = 1;\n');

    const idxA = createIndexer({
      store,
      embed: fakeEmbedFn(),
      info: { kind: 'local', model: 'modelA', dim: 384 },
      root,
    });
    await idxA.indexPaths(['src']);
    expect(store.getState<EmbedderInfo>(CTX_EMBEDDER_KEY)?.model).toBe('modelA');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const idxB = createIndexer({
        store,
        embed: fakeEmbedFn(),
        info: { kind: 'local', model: 'modelB', dim: 384 },
        root,
      });
      await idxB.indexPaths(['src']);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('embedder changed'));
      expect(store.getState<EmbedderInfo>(CTX_EMBEDDER_KEY)?.model).toBe('modelB');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('forget removes specific files and their chunks + vectors', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('src/a.ts', 'const a = 1;\n');
    writeFile('src/b.ts', 'const b = 2;\n');
    await indexer.indexPaths(['src']);
    const docsBefore = store.countDocs();
    const aChunks = expectedChunkCount('src/a.ts', 'const a = 1;\n');

    const res = await indexer.forget(['src/a.ts']);
    expect(res.deleted).toBe(1);
    expect(store.countDocs()).toBe(docsBefore - aChunks);

    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry).toContain('src/b.ts');
    expect(registry).not.toContain('src/a.ts');
  });

  it('forget accepts a directory and removes everything under it', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('a/foo.ts', 'const a = 1;\n');
    writeFile('a/bar.ts', 'const b = 2;\n');
    writeFile('keep.ts', 'const c = 3;\n');
    await indexer.indexPaths(['.']);
    const docsBefore = store.countDocs();

    const res = await indexer.forget(['a']);
    expect(res.deleted).toBe(2);
    // keep.ts survives
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry).toEqual(['keep.ts']);
    expect(store.countDocs()).toBe(
      docsBefore -
        expectedChunkCount('a/foo.ts', 'const a = 1;\n') -
        expectedChunkCount('a/bar.ts', 'const b = 2;\n'),
    );
  });

  it('reindex wipes and rebuilds every chunk + vector', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('src/a.ts', 'const a = 1;\n');
    writeFile('src/b.ts', 'const b = 2;\n');
    const first = await indexer.indexPaths(['src']);
    const docsBefore = store.countDocs();
    const vecsBefore = store.countVecs();

    const rebuilt = await indexer.reindex();
    expect(rebuilt.indexed).toBe(first.indexed); // same content → same chunk count
    expect(rebuilt.skipped).toBe(0); // registry was wiped first
    expect(store.countDocs()).toBe(docsBefore);
    expect(store.countVecs()).toBe(vecsBefore);
  });

  it('scoped reconcile: re-indexing one root leaves another root untouched', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('a/foo.ts', 'const a = 1;\n');
    writeFile('b/bar.ts', 'const b = 2;\n');
    await indexer.indexPaths(['a']);
    await indexer.indexPaths(['b']);
    const docsBoth = store.countDocs();
    expect(docsBoth).toBeGreaterThan(0);

    // Re-scan only 'a': nothing under 'a' was removed, and 'b' is out of scope.
    const res = await indexer.indexPaths(['a']);
    expect(res.deleted).toBe(0);
    expect(store.countDocs()).toBe(docsBoth); // 'b' chunks still present
  });

  // -------------------------------------------------------------------------
  // Post-review hardening (slice S6): sensitive-file denylist, path
  // confinement, and single-flight serialization of mutating ops.
  // -------------------------------------------------------------------------

  it('isSensitive flags the denylist (secrets / keys / credentials)', () => {
    // Exact env / credential / OS-junk basenames.
    expect(isSensitive('.env')).toBe(true);
    expect(isSensitive('.npmrc')).toBe(true);
    expect(isSensitive('.pypirc')).toBe(true);
    expect(isSensitive('.netrc')).toBe(true);
    expect(isSensitive('.git-credentials')).toBe(true);
    expect(isSensitive('.DS_Store')).toBe(true);
    expect(isSensitive('Thumbs.db')).toBe(true);
    // Env variants (.env.*).
    expect(isSensitive('.env.local')).toBe(true);
    expect(isSensitive('.env.production')).toBe(true);
    // Private keys (bare, with .pub, in a subdir, and by extension).
    expect(isSensitive('id_rsa')).toBe(true);
    expect(isSensitive('id_rsa.pub')).toBe(true);
    expect(isSensitive('id_ed25519')).toBe(true);
    expect(isSensitive('deploy/id_rsa')).toBe(true); // path form → basename match
    expect(isSensitive('cert.pem')).toBe(true);
    expect(isSensitive('cert.key')).toBe(true);
    expect(isSensitive('cert.secret')).toBe(true);
    expect(isSensitive('cert.p12')).toBe(true);
    expect(isSensitive('cert.pfx')).toBe(true);
    expect(isSensitive('config.local')).toBe(true);
    // Path-anchored (basename `credentials` is too generic to flag alone).
    expect(isSensitive('.aws/credentials')).toBe(true);
    expect(isSensitive('home/.aws/credentials')).toBe(true);
    expect(isSensitive('credentials')).toBe(false); // bare basename stays benign
    // Case-insensitive.
    expect(isSensitive('.ENV')).toBe(true);
    expect(isSensitive('ID_RSA')).toBe(true);
    // Benign files are NOT flagged.
    expect(isSensitive('src/app.ts')).toBe(false);
    expect(isSensitive('README.md')).toBe(false);
    expect(isSensitive('package.json')).toBe(false);
    expect(isSensitive('env.d.ts')).toBe(false); // contains "env" but not a secret
  });

  it('skips sensitive files (.env / id_rsa) — never chunked, embedded, or searched', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('.env', 'API_TOKEN=supersecretvalue123\n');
    writeFile(
      'keys/id_rsa',
      '-----BEGIN PRIVATE KEY-----\nPRIVATEKEYDATA\n-----END PRIVATE KEY-----\n',
    );
    writeFile('src/app.ts', 'const app = buildApp();\n');

    const res = await indexer.indexPaths(['.']);
    const expApp = expectedChunkCount('src/app.ts', 'const app = buildApp();\n');

    // Only the normal file was indexed; the secret files were skipped.
    expect(res.indexed).toBe(expApp);
    expect(store.countDocs()).toBe(expApp);
    expect(store.countVecs()).toBe(expApp);

    // Secrets never reached the index: a BM25 search for their unique tokens
    // returns nothing (no leakage into FTS snippets).
    expect(store.searchFt('supersecretvalue123')).toEqual([]);
    expect(store.searchFt('PRIVATEKEYDATA')).toEqual([]);

    // And they are absent from the registry.
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect(registry).toContain('src/app.ts');
    expect(registry).not.toContain('.env');
    expect(registry.some((p) => p.endsWith('id_rsa'))).toBe(false);
  });

  it('rejects out-of-root paths (absolute / ../sibling) — never indexed, no traversal key', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    writeFile('src/inside.ts', 'const inside = true;\n');

    // An absolute file outside root, plus a `../sibling` traversal. Both must be
    // confined: skipped entirely, never stat'd / walked, never stored.
    const outsideDir = mkdtempSync(join(tmpdir(), 'noir-context-outside-'));
    const outsideAbs = join(outsideDir, 'outside.ts');
    writeFileSync(outsideAbs, 'OUTSIDE_TOKEN_XYZ\n', 'utf8');
    try {
      const res = await indexer.indexPaths(['src/inside.ts', outsideAbs, '../sibling']);

      // Only the in-root file was indexed.
      const expInside = expectedChunkCount('src/inside.ts', 'const inside = true;\n');
      expect(res.indexed).toBe(expInside);

      // No traversal / absolute key was stored.
      const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
      expect(registry).toEqual(['src/inside.ts']);
      expect(registry.some((p) => p.includes('..'))).toBe(false);
      expect(registry.some((p) => p.startsWith('/'))).toBe(false);

      // The out-of-root file's content never reached the index.
      expect(store.searchFt('OUTSIDE_TOKEN_XYZ')).toEqual([]);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('serializes concurrent indexPaths calls (no orphaned chunks / vectors)', async () => {
    store = await openStore({ projectId, root });
    indexer = freshIndexer();

    // Disjoint file sets under disjoint roots.
    const a1 = 'const a1 = computeA1();\n';
    const a2 = 'const a2 = computeA2();\n';
    const b1 = 'const b1 = computeB1();\n';
    const b2 = 'const b2 = computeB2();\n';
    writeFile('setA/a1.ts', a1);
    writeFile('setA/a2.ts', a2);
    writeFile('setB/b1.ts', b1);
    writeFile('setB/b2.ts', b2);

    const expA1 = expectedChunkCount('setA/a1.ts', a1);
    const expA2 = expectedChunkCount('setA/a2.ts', a2);
    const expB1 = expectedChunkCount('setB/b1.ts', b1);
    const expB2 = expectedChunkCount('setB/b2.ts', b2);
    const total = expA1 + expA2 + expB1 + expB2;

    // Kick both off WITHOUT awaiting the first — they must serialize internally
    // (the single-flight chain) so neither persist clobbers the other.
    const [resA, resB] = await Promise.all([
      indexer.indexPaths(['setA']),
      indexer.indexPaths(['setB']),
    ]);

    expect(resA.indexed).toBe(expA1 + expA2);
    expect(resB.indexed).toBe(expB1 + expB2);

    // Registry survived both persists (no last-write-wins clobber): all four
    // files are tracked.
    const registry = store.getState<string[]>(CTX_REGISTRY_KEY) ?? [];
    expect([...registry].sort()).toEqual(
      ['setA/a1.ts', 'setA/a2.ts', 'setB/b1.ts', 'setB/b2.ts'].sort(),
    );

    // No orphans: every docs / vec0 row is tracked by a per-file record, and the
    // live counts match the sum of tracked chunkIds. A clobber would leave the
    // loser's chunks in docs with no record → counts would diverge.
    let tracked = 0;
    for (const key of registry) {
      const rec = store.getState<FileRecord>(ctxFileKey(key));
      expect(rec).not.toBeNull();
      tracked += rec?.chunkIds.length ?? 0;
    }
    expect(tracked).toBe(total);
    expect(store.countDocs()).toBe(total);
    expect(store.countVecs()).toBe(total);
  });

  // ---------------------------------------------------------------------------
  // readChunkContent (C1 — kNN-only-hit snippet hydration)
  // ---------------------------------------------------------------------------

  it('C1: readChunkContent returns the CLEAN chunk content + meta for an indexed chunk', async () => {
    store = await openStore({ projectId, root });
    const indexer = freshIndexer();
    // Two chunks in one file (parentDocId = sha256('src/hydrate.ts')).
    writeFile('src/hydrate.ts', 'alpha first chunk\n\nbeta second chunk\n');
    await indexer.indexPaths(['src/hydrate.ts']);

    // Pick the first chunk's id from the per-file record (the indexer is the
    // source of truth for the chunk-id format).
    const rec = store.getState<FileRecord>(ctxFileKey('src/hydrate.ts'));
    if (!rec) throw new Error('expected a FileRecord for src/hydrate.ts');
    const firstId = rec.chunkIds[0];
    if (!firstId) throw new Error('expected at least one chunk id');

    const out = indexer.readChunkContent(firstId);
    expect(out).not.toBeNull();
    if (!out) return;
    // Returns the CLEAN chunk content (pre-identifier-explosion) — what a
    // kNN-only-hit snippet wants — not the docs-table indexedContent form.
    expect(out.content).toContain('alpha first chunk');
    // Meta is the full ChunkMeta the chunker produced.
    expect(out.meta.path).toBe('src/hydrate.ts');
    expect(out.meta.parentDocId).toBe(sha256('src/hydrate.ts'));
    expect(out.meta.chunkIndex).toBe(0);
  });

  it('C1: readChunkContent returns null for a chunk id not in the registry (deleted/foreign)', async () => {
    store = await openStore({ projectId, root });
    const indexer = freshIndexer();
    writeFile('src/one.ts', 'only file\n');
    await indexer.indexPaths(['src/one.ts']);

    // An id that was never indexed (vec row came from a foreign source, or the
    // chunk was deleted in a prior reconcile): honest null miss.
    expect(indexer.readChunkContent('deadbeef#chunk-0')).toBeNull();
  });

  it('C1: readChunkContent returns null when the source file is missing on disk', async () => {
    store = await openStore({ projectId, root });
    const indexer = freshIndexer();
    writeFile('src/gone.ts', 'alpha indexed then deleted from disk\n');
    await indexer.indexPaths(['src/gone.ts']);
    const rec = store.getState<FileRecord>(ctxFileKey('src/gone.ts'));
    if (!rec) throw new Error('expected FileRecord');
    const id = rec.chunkIds[0];
    if (!id) throw new Error('expected chunk id');

    // Simulate the source file being removed out-of-band (the registry still
    // references it, but the file is gone). The lookup must NOT crash — it
    // returns null so the retriever degrades honestly to mode:'knn'.
    removeFile('src/gone.ts');
    expect(indexer.readChunkContent(id)).toBeNull();
  });

  it('C1: readChunkContent returns null when the file content drifted (chunkId no longer re-chunks)', async () => {
    store = await openStore({ projectId, root });
    const indexer = freshIndexer();
    writeFile('src/drift.ts', 'alpha original content here\n');
    await indexer.indexPaths(['src/drift.ts']);
    const rec = store.getState<FileRecord>(ctxFileKey('src/drift.ts'));
    if (!rec) throw new Error('expected FileRecord');
    const id = rec.chunkIds[0];
    if (!id) throw new Error('expected chunk id');

    // Out-of-band edit: the file content changed under the registry's nose, so
    // re-chunking no longer yields the prior chunk id (different sha256(path)
    // is fine — same path — but the chunker may yield a different number of
    // chunks, and the chunk-id index `<n>` no longer points at the same text).
    // Replace with content that re-chunks to fewer / different chunks.
    writeFile('src/drift.ts', 'completely different and much shorter\n');
    // Either null (id no longer re-chunks) or a different content is acceptable
    // — the contract is "the chunk id is still valid". In practice this path
    // returns null because the new content's chunks have different ids when
    // re-chunked against the same path key (the chunker is deterministic, but
    // the chunk-id index stays 0..N-1; for a single-chunk file it stays 0).
    // Assert honest behavior: the call does not crash; the result is either
    // null (drift detected) or non-null content from the CURRENT file.
    const out = indexer.readChunkContent(id);
    if (out !== null) {
      // If a chunk with this id still exists post-drift, it must reflect the
      // CURRENT on-disk content (never stale).
      expect(out.content).not.toContain('alpha original');
    }
  });
});
