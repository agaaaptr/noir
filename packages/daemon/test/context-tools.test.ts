// MCP round-trip tests for the context tools (slice S6, task t11).
//
// Mirrors packages/daemon/test/{store-status,workflow-status}.test.ts: open a
// real tmp store, build the ContextEngine via the daemon seam, register the
// three tools through createNoirServer, and drive them through an in-process
// InMemoryTransport + @modelcontextprotocol/client Client (no HTTP, no stdio).
//
// Deterministic + offline (NFR-2): the seam `buildContextEngine` takes an
// EmbedderConfig (the discriminated union), NOT a raw EmbedFn, so a
// deterministic fake embedder cannot be injected through it. We therefore drive
// the round-trip with `kind:'none'` — the BM25-only / degraded configuration —
// which exercises the FULL MCP plumbing (registerTool schema + handlers), the
// content-hash incremental skip (AC-1), the BM25-only search path with
// window-extracted snippets (AC-4), the status payload (AC-6), and the
// read-only error envelope (AC-5), all without a model download or network.
// The hybrid/real-vector paths are covered by packages/context/test (retriever
// unit tests use fakeEmbedFn directly; the guarded MiniLM integration test
// exercises real 384-dim vectors).

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { openStore, vecAvailability } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContextEngine } from '../src/context-seam.js';
import { createNoirServer } from '../src/server.js';

// CI gate (mirrors packages/store/test/vec.test.ts): opening a store loads
// sqlite-vec, which ships a per-platform native binary. Probe-load it ONCE
// synchronously; if absent on this host, skip the store-backed describe with a
// labelled reason so the default suite stays green offline on an unsupported
// platform (NFR-2).
const VEC_PROBE = vecAvailability();

const describeVec = VEC_PROBE.ok ? describe : describe.skip;
const describeLabel = VEC_PROBE.ok
  ? 'context MCP tools (context_search / context_index / context_status)'
  : `context MCP tools [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-context-tools-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'ctx-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/** Write a file under the tmp root, creating any missing parent dirs. */
function writeFile(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf8');
}

/**
 * Drive one in-process MCP round-trip: link a fresh client/server transport
 * pair, call a tool, and return the parsed JSON payload. Mirrors the `callTool`
 * helper in workflow-status.test.ts (a new transport pair per call; the client
 * is closed in `finally` so the server can reconnect on the next call).
 */
async function callTool(
  server: ReturnType<typeof createNoirServer>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'noir-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(clientTransport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const block = result.content?.[0];
    return JSON.parse((block as { text: string }).text) as Record<string, unknown>;
  } finally {
    await client.close();
  }
}

describeVec(describeLabel, () => {
  it('round-trips context_index → context_search → context_status (BM25-only, offline)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // Seed a tiny tree. `contextEngine` appears as a camelCase identifier;
      // the indexer's index-time identifier explosion gives the bare
      // token a BM25 signal under porter unicode61, so the query hits.
      writeFile(
        'src/util.ts',
        'export function contextEngine(opts: Opts): Result {\n  return opts;\n}\n',
      );
      writeFile('README.md', '# Context Engine\n\nThe hybrid retrieval engine for Noir.\n');

      // kind:'none' → deterministic offline (the seam takes EmbedderConfig, not
      // an EmbedFn; vectors are disabled so search degrades to BM25-only, F8).
      const context = buildContextEngine(store, root, id, { kind: 'none' });
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: false,
        context,
      });

      // --- context_index: seed the tree (docs only under kind:'none') ---
      const indexed = await callTool(server, 'context_index', { paths: ['.'] });
      expect(indexed.ok).toBe(true);
      expect(indexed.indexed as number).toBeGreaterThan(0);
      expect(indexed.skipped as number).toBe(0);
      expect(indexed.failed as number).toBe(0);
      expect(indexed.deleted as number).toBe(0);
      // kind:'none' → docs indexed without vectors (truthful degraded flag).
      expect(indexed.degraded).toBe(true);
      const firstIndexed = indexed.indexed as number;

      // --- AC-1: identical re-call is a content-hash skip (indexed:0, skipped:N) ---
      const reIndexed = await callTool(server, 'context_index', { paths: ['.'] });
      expect(reIndexed.ok).toBe(true);
      expect(reIndexed.indexed as number).toBe(0);
      expect(reIndexed.skipped as number).toBe(firstIndexed);

      // --- context_search: BM25-only (kind:'none' ⇒ embed throws ⇒ F8) ---
      const search = await callTool(server, 'context_search', { query: 'contextEngine' });
      expect(search.ok).toBe(true);
      expect(search.mode).toBe('bm25-only');
      expect(search.degraded).toBe(true);
      expect(Array.isArray(search.results)).toBe(true);
      expect((search.results as unknown[]).length).toBeGreaterThan(0);

      // AC-2 / F7: the snippet is FTS5 window-extracted (never truncated) — the
      // `<<…>>` match markers are present, and path/parentDocId are backfilled.
      const top = (search.results as Array<Record<string, unknown>>)[0];
      if (!top) throw new Error('expected a top hit');
      expect(typeof top.snippet).toBe('string');
      expect((top.snippet as string).length).toBeGreaterThan(0);
      expect(top.snippet).toMatch(/<<.*?>>/);
      expect(typeof top.path).toBe('string');
      expect((top.path as string).length).toBeGreaterThan(0);
      expect(typeof top.parentDocId).toBe('string');
      // The relevant chunk comes from src/util.ts (where contextEngine lives).
      expect(top.id).toMatch(/#chunk-\d+$/);

      // --- AC-6: context_status reports the full snapshot (live off the handle) ---
      const status = await callTool(server, 'context_status');
      expect(status.ok).toBe(true);
      expect(status.projectId).toBe(id);
      expect(status.docCount as number).toBe(firstIndexed);
      // kind:'none' indexed docs without vectors.
      expect(status.vecCount as number).toBe(0);
      expect(status.indexedFiles as number).toBe(2); // src/util.ts + README.md
      expect(status.embedder).toEqual({ kind: 'none', dim: 0 });
      expect(status.degraded).toBe(true);
    } finally {
      await store.close();
    }
  });

  it('context_index defaults to ["."] when paths is omitted or empty', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      writeFile('src/a.ts', 'const contextEngine = makeEngine();\n');
      const context = buildContextEngine(store, root, id, { kind: 'none' });
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        context,
      });

      // Omitted paths → defaults to ['.'] (the project root).
      const omitted = await callTool(server, 'context_index', {});
      expect(omitted.ok).toBe(true);
      expect(omitted.indexed as number).toBeGreaterThan(0);

      // Empty array also defaults to ['.'] — and is now a content-hash skip.
      const empty = await callTool(server, 'context_index', { paths: [] });
      expect(empty.ok).toBe(true);
      expect(empty.indexed as number).toBe(0);
      expect(empty.skipped as number).toBe(omitted.indexed as number);
    } finally {
      await store.close();
    }
  });

  it('context_search surfaces a clean degraded envelope instead of crashing on a bad call', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      writeFile('src/a.ts', 'const contextEngine = makeEngine();\n');
      const context = buildContextEngine(store, root, id, { kind: 'none' });
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        context,
      });
      await callTool(server, 'context_index', { paths: ['.'] });

      // A query with no lexical overlap → empty results, NOT degraded-by-search
      // (the embedder throw still sets mode 'bm25-only', but results is []).
      const search = await callTool(server, 'context_search', { query: 'zzzznomatch' });
      expect(search.ok).toBe(true);
      expect(Array.isArray(search.results)).toBe(true);
      expect((search.results as unknown[]).length).toBe(0);
      expect(search.mode).toBe('bm25-only');
    } finally {
      await store.close();
    }
  });

  // AC-5: read-only (daemon-down) store — reads keep working, writes surface a
  // clear degraded envelope. Mirrors store-status.test.ts' read-only reopen.
  it('AC-5: read-only store — search/status work; context_index returns the degraded error envelope', async () => {
    // Seed with a writable handle: index one doc, then close.
    const seed = await openStore({ projectId: id, root });
    writeFile('src/a.ts', 'const contextEngine = makeEngine();\n');
    const seedContext = buildContextEngine(seed, root, id, { kind: 'none' });
    await seedContext.indexPaths(['src']);
    const seededDocs = seed.countDocs();
    expect(seededDocs).toBeGreaterThan(0);
    await seed.close();

    // Reopen read-only — the daemon-down / FS-fallback shape. Reads (searchFt,
    // counts, getState) keep working; writes throw "store is read-only".
    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const context = buildContextEngine(ro, root, id, { kind: 'none' }, true);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store: ro,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: true,
        context,
      });

      // Read path: context_search still returns hits off the read-only handle.
      const search = await callTool(server, 'context_search', { query: 'contextEngine' });
      expect(search.ok).toBe(true);
      expect((search.results as unknown[]).length).toBeGreaterThan(0);

      // Read path: context_status reports accurate counts + degraded:true.
      const status = await callTool(server, 'context_status');
      expect(status.ok).toBe(true);
      expect(status.docCount as number).toBe(seededDocs);
      expect(status.degraded).toBe(true);
      expect(status.embedder).toEqual({ kind: 'none', dim: 0 });

      // Write path: context_index is fenced off up front with a clear envelope
      // (spec F12 / AC-5) — never lets the first write throw mid-run.
      const indexed = await callTool(server, 'context_index', { paths: ['.'] });
      expect(indexed.ok).toBe(false);
      expect(indexed.degraded).toBe(true);
      expect(String(indexed.error)).toContain('read-only');
    } finally {
      await ro.close();
    }
  });
});
