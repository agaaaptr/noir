// MCP round-trip tests for the memory tools (slice S7, task t4).
//
// Mirrors packages/daemon/test/context-tools.test.ts: open a real tmp store,
// build the MemoryEngine via the daemon seam, register the tools through
// createNoirServer, and drive them through an in-process InMemoryTransport +
// @modelcontextprotocol/client Client (no HTTP, no stdio).
//
// Deterministic + offline (NFR-2): the seam takes the `EmbedFn` the daemon
// resolved once, so we inject `kind:'none'` (the BM25-only / degraded embedder)
// — memory_save still succeeds (the embedder throw is caught best-effort; the
// row is BM25-searchable + hydrated from KV), and memory_recall degrades to
// BM25-only. This exercises the FULL MCP plumbing (registerTool schema +
// handlers), the DS-9 full-content hydration, the sessions rollup, forget, the
// read-only error envelope, and the provider-gated consolidation registration +
// refusal (never a silent paid call). The hybrid/real-vector paths are covered
// by packages/memory/test (recall unit tests use fakeEmbedFn directly).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createEmbedFn } from '@noir-ai/context';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { resolveMemoryConfig } from '@noir-ai/memory';
import { resolveModelConfig } from '@noir-ai/model';
import { openStore, vecAvailability } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildMemoryEngine,
  resolveConsolidationCapability,
  resolveMemoryConsolidation,
} from '../src/memory-seam.js';
import { createNoirServer } from '../src/server.js';

// CI gate (mirrors context-tools.test.ts): opening a store loads sqlite-vec,
// which ships a per-platform native binary. Probe-load it ONCE synchronously;
// if absent on this host, skip the store-backed describe with a labelled reason
// so the default suite stays green offline on an unsupported platform (NFR-2).
const VEC_PROBE = vecAvailability();

const describeVec = VEC_PROBE.ok ? describe : describe.skip;
const describeLabel = VEC_PROBE.ok
  ? 'memory MCP tools (memory_save / recall / search / sessions / forget / consolidate)'
  : `memory MCP tools [SKIPPED — sqlite-vec native binary unavailable: ${VEC_PROBE.reason}]`;

// Deterministic offline embedder: kind:'none' throws on embed() → memory_save
// skips the vec index (FTS + KV only) and memory_recall degrades to BM25-only.
const embed = createEmbedFn({ kind: 'none' }).embed;

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-memory-tools-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'mem-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/**
 * Drive one in-process MCP round-trip: link a fresh client/server transport
 * pair, call a tool, and return the parsed JSON payload. Mirrors the `callTool`
 * helper in context-tools.test.ts (a new transport pair per call; the client is
 * closed in `finally` so the server can reconnect on the next call).
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

/** List registered tool names (a new transport pair, mirroring {@link callTool}). */
async function listToolNames(server: ReturnType<typeof createNoirServer>): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'noir-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(clientTransport);
  try {
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name);
  } finally {
    await client.close();
  }
}

describeVec(describeLabel, () => {
  it('round-trips memory_save → recall → search → sessions → forget (BM25-only, offline)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const memory = buildMemoryEngine(store, root, id, embed);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        memory,
      });

      // --- memory_save: persist one observation (FTS + KV; vec skipped under
      // kind:'none' via the engine's best-effort embed) ---
      const saved = await callTool(server, 'memory_save', {
        content: 'always resolve the embedder once per serve lifecycle',
        type: 'pattern',
        concepts: ['embedder', 'lifecycle'],
        files: ['packages/daemon/src/memory-seam.ts'],
        importance: 0.8,
        sessionId: 's1',
      });
      expect(saved.ok).toBe(true);
      expect(typeof saved.id).toBe('string');
      expect((saved.observation as Record<string, unknown>).type).toBe('pattern');
      // DS-9: the full content round-trips untruncated.
      expect((saved.observation as Record<string, unknown>).content).toBe(
        'always resolve the embedder once per serve lifecycle',
      );
      const obsId = saved.id as string;

      // --- memory_recall: BM25-only (kind:'none' ⇒ embed throws ⇒ F8) ---
      const recall = await callTool(server, 'memory_recall', { query: 'embedder lifecycle' });
      expect(recall.ok).toBe(true);
      expect(Array.isArray(recall.results)).toBe(true);
      const results = recall.results as Array<Record<string, unknown>>;
      expect(results.length).toBeGreaterThan(0);
      const top = results[0];
      if (!top) throw new Error('expected a recall hit');
      expect(top.id).toBe(obsId);
      // DS-9: full content hydrated from the authoritative KV row.
      expect(top.content).toBe('always resolve the embedder once per serve lifecycle');
      expect(top.type).toBe('pattern');

      // --- memory_search: instant BM25-only path, full content ---
      const search = await callTool(server, 'memory_search', { query: 'embedder' });
      expect(search.ok).toBe(true);
      expect(Array.isArray(search.hits)).toBe(true);
      const hits = search.hits as Array<Record<string, unknown>>;
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.content).toBe('always resolve the embedder once per serve lifecycle');

      // --- memory_sessions: the save bumped the s1 rollup ---
      const sessions = await callTool(server, 'memory_sessions', {});
      expect(sessions.ok).toBe(true);
      const sList = sessions.sessions as Array<Record<string, unknown>>;
      expect(sList.length).toBe(1);
      expect(sList[0]?.id).toBe('s1');
      expect(sList[0]?.count).toBe(1);

      // --- memory_forget: removes the row; subsequent recall is empty ---
      const forgot = await callTool(server, 'memory_forget', { ids: [obsId] });
      expect(forgot.ok).toBe(true);
      expect(forgot.deleted).toBe(1);
      const afterRecall = await callTool(server, 'memory_recall', { query: 'embedder' });
      expect((afterRecall.results as unknown[]).length).toBe(0);
      // The session rollup cleaned up its now-empty entry.
      const afterSessions = await callTool(server, 'memory_sessions', {});
      expect((afterSessions.sessions as unknown[]).length).toBe(0);
    } finally {
      await store.close();
    }
  });

  // AC-5 mirror: read-only (daemon-down) store — reads keep working, writes
  // surface a clear degraded envelope. Mirrors context-tools.test.ts' read-only
  // reopen + the store-status read-only test.
  it('AC-5: read-only store — recall/search/sessions work; save + forget return the degraded error envelope', async () => {
    // Seed with a writable handle: save one observation, then close.
    const seed = await openStore({ projectId: id, root });
    const seedMemory = buildMemoryEngine(seed, root, id, embed);
    const seeded = await seedMemory.save({
      content: 'canonical ProjectId is never a filesystem path',
      type: 'architecture',
      sessionId: 's-seed',
    });
    expect(seeded.id).toBeTruthy();
    await seed.close();

    // Reopen read-only — the daemon-down / FS-fallback shape. Reads (searchFt,
    // counts, getState) keep working; writes throw "store is read-only".
    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const memory = buildMemoryEngine(ro, root, id, embed, undefined, true);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store: ro,
        storeDegraded: true,
        memory,
      });

      // Read path: recall still returns the seeded hit off the read-only handle.
      const recall = await callTool(server, 'memory_recall', { query: 'ProjectId' });
      expect(recall.ok).toBe(true);
      expect((recall.results as unknown[]).length).toBeGreaterThan(0);

      // Read path: sessions still lists the seeded session.
      const sessions = await callTool(server, 'memory_sessions', {});
      expect(sessions.ok).toBe(true);
      expect((sessions.sessions as unknown[]).length).toBe(1);

      // Write path: memory_save is fenced off up front with a clear envelope.
      const saved = await callTool(server, 'memory_save', { content: 'x' });
      expect(saved.ok).toBe(false);
      expect(saved.degraded).toBe(true);
      expect(String(saved.error)).toContain('read-only');

      // Write path: memory_forget is fenced off too.
      const forgot = await callTool(server, 'memory_forget', { ids: [seeded.id] });
      expect(forgot.ok).toBe(false);
      expect(forgot.degraded).toBe(true);
      expect(String(forgot.error)).toContain('read-only');
    } finally {
      await ro.close();
    }
  });

  // OQ-5 / DS-6: memory_consolidate is registered ONLY when a consolidation-
  // capable engine is present (an explicit provider+model resolved from the
  // model config). With no model config ⇒ not registered; the five core tools
  // still are.
  it('does NOT register memory_consolidate when no provider is configured (opt-in)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      // No modelCfg ⇒ resolveMemoryConsolidation → null ⇒ memoryConsolidation false.
      const memory = buildMemoryEngine(store, root, id, embed);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        memory,
        memoryConsolidation: resolveMemoryConsolidation(undefined) !== null,
      });
      const names = await listToolNames(server);
      // The five core tools are present.
      const coreTools = [
        'memory_save',
        'memory_recall',
        'memory_search',
        'memory_sessions',
        'memory_forget',
      ];
      for (const n of coreTools) {
        expect(names).toContain(n);
      }
      // Consolidation is NOT registered (no provider ⇒ opt-out).
      expect(names).not.toContain('memory_consolidate');
    } finally {
      await store.close();
    }
  });

  // DS-6 / §9 hard rule — the consent boundary is `memory.consolidation.enabled`,
  // NOT `model.defaultProvider`. The `memory:` block is the user's master switch;
  // the `model:` block only provides the provider+key the bound S8 `complete`
  // uses once the switch is ON. Two cases:
  //  (a) enabled + provider+model under `memory:` ⇒ `memory_consolidate` IS
  //      registered, and refuses `model-unavailable` when the provider's key env
  //      is unset (S8 wired but can't actually call — no paid call);
  //  (b) the C1 inverse: `enabled:false` + `model.defaultProvider:'anthropic'`
  //      (set for summarize/title/draft, NOT memory) ⇒ `memory_consolidate` is
  //      NOT registered, and the engine refuses without a model call. This is the
  //      line against the Agent-Memory "silent paid consolidation" leak — the
  //      exact bug this test replaces (the prior green encoded the bypass: it
  //      registered the tool from `model:` alone, ignoring the absent `memory:`
  //      consent, which is blueprint §9's anti-pattern).
  it('gates memory_consolidate on memory.consolidation.enabled — no silent paid call (C1)', async () => {
    // Provider block reused across both cases: an anthropic block whose key env
    // is intentionally unset (a name nothing in the test env provides).
    const modelCfg = resolveModelConfig({
      defaultProvider: 'anthropic',
      providers: {
        anthropic: { model: 'claude-haiku', apiKeyEnv: 'NOIR_TEST_KEY_UNSET_Q9F2K' },
      },
    });

    // --- (a) valid-capable: enabled + provider+model under `memory:` ---
    const store = await openStore({ projectId: id, root });
    try {
      const capableMemory = resolveMemoryConfig({
        consolidation: { enabled: true, provider: 'anthropic', model: 'claude-haiku' },
      });
      // The gate resolves the memory-block provider+model (enabled is true).
      expect(resolveConsolidationCapability(capableMemory, modelCfg)).toEqual({
        provider: 'anthropic',
        model: 'claude-haiku',
      });
      const memory = buildMemoryEngine(store, root, id, embed, modelCfg, undefined, capableMemory);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        memory,
        memoryConsolidation: resolveConsolidationCapability(capableMemory, modelCfg) !== null,
      });
      const names = await listToolNames(server);
      expect(names).toContain('memory_consolidate');

      // Seed one candidate so the gate advances past 'no-candidates' to the S8
      // call (which returns null because the key env is unset).
      const saved = await callTool(server, 'memory_save', {
        content: 'a consolidatable observation',
        type: 'fact',
      });
      expect(saved.ok).toBe(true);

      const cons = await callTool(server, 'memory_consolidate', {});
      expect(cons.ok).toBe(false);
      expect(cons.reason).toBe('model-unavailable');
      expect(cons.logged).toBe(true);
    } finally {
      await store.close();
    }

    // --- (b) C1 inverse: enabled:false + model.defaultProvider set ---
    // The blueprint §9 leak: a user who set `model.defaultProvider:'anthropic'`
    // for summarize/title/draft but opted OUT of memory consolidation
    // (`enabled:false`) must NOT get a paid Anthropic consolidation call. The
    // model-derived derivation alone WOULD resolve a provider (the bug vector) —
    // the master-switch gate MUST suppress it.
    const optedOutMemory = resolveMemoryConfig({
      consolidation: { enabled: false },
    });
    // Sanity: the model-derived fallback still resolves on its own...
    expect(resolveMemoryConsolidation(modelCfg)).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku',
    });
    // ...but the master switch (enabled === false) forces the gate to null.
    expect(resolveConsolidationCapability(optedOutMemory, modelCfg)).toBe(null);

    const c1Store = await openStore({ projectId: id, root });
    try {
      const memory = buildMemoryEngine(
        c1Store,
        root,
        id,
        embed,
        modelCfg,
        undefined,
        optedOutMemory,
      );
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store: c1Store,
        memory,
        memoryConsolidation: resolveConsolidationCapability(optedOutMemory, modelCfg) !== null,
      });
      const names = await listToolNames(server);
      // The five core tools are present; consolidation is NOT registered.
      for (const n of [
        'memory_save',
        'memory_recall',
        'memory_search',
        'memory_sessions',
        'memory_forget',
      ]) {
        expect(names).toContain(n);
      }
      expect(names).not.toContain('memory_consolidate');
    } finally {
      await c1Store.close();
    }
  });
});
