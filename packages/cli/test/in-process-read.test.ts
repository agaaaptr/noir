// G1 — in-process read-only fallback when the daemon is down (S9 DS-5).
//
// Store-touching commands normally route through the daemon (the single writer).
// When the daemon is DOWN, READS (context search / memory recall / memory
// sessions / task status) fall back to an in-process read-only store + engines
// via `withInProcessRead` (daemon-client.ts) — exit 0 with real results instead
// of exit 4. WRITES (task new / task advance / memory save / memory forget /
// context index) KEEP the daemon-required exit-4 path (single-writer
// invariant): they never open a store for writes in-process.
//
// Offline by construction (NF4): the daemon liveness probe is mocked to report
// `{running:false}` (no real daemon, no HTTP), and the store is a real
// temp-dir SQLite DB seeded through `openStore` (writable) + the engine
// factories — the same primitives `withInProcessRead` uses, so the fallback
// reads are exercised against REAL storage, not a stub.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, createEmbedFn } from '@noir-ai/context';
import { type ProjectInfo, parseConfig } from '@noir-ai/core';
import { createMemoryEngine } from '@noir-ai/memory';
import { openStore } from '@noir-ai/store';
import { WorkflowEngine } from '@noir-ai/workflow';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- daemon-client mocked at the module boundary (no real daemon / HTTP) ---
// `probeDaemon` reports daemon-down; everything else (including the real
// `withInProcessRead` under test) stays REAL so the in-process fallback
// (openStore + engine construction) runs against the real primitives.
const { probeHolder } = vi.hoisted(() => ({
  probeHolder: {
    current: { running: false } as { running: boolean; pid?: number; port?: number },
  },
}));

vi.mock('../src/daemon-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon-client.js')>();
  return {
    ...actual,
    probeDaemon: vi.fn(async () => probeHolder.current),
  };
});

// WRITES go through `withDaemon` → `resolveDaemon` → `ensureDaemonRunning`.
// With the daemon down, that must REJECT so the write keeps its exit-4 path
// (it must never open a store for writes in-process — single-writer). Stub the
// daemon's ensure to reject → daemon-client maps it to exit 4. No real daemon
// is ever started (NF4).
//
// `readDaemonRecord`/`pidAlive` are also exported: some importers resolve the
// REAL daemon-client module (the `importOriginal` partial mock above can yield
// a second instance for other importers), whose `probeDaemon` reads the record.
// A no-record/no-alive probe degrades to `{running:false}` cleanly — matching
// the mocked probe and keeping every read on the fallback path offline.
vi.mock('@noir-ai/daemon', () => ({
  ensureDaemonRunning: vi.fn(async () => {
    throw new Error('daemon down (test)');
  }),
  readDaemonRecord: () => null,
  pidAlive: () => false,
}));

import { contextSearch } from '../src/commands/context.js';
import { memoryRecall, memorySessions } from '../src/commands/memory.js';
import { taskNew, taskStatus } from '../src/commands/task.js';
import { probeDaemon, withInProcessRead } from '../src/daemon-client.js';

// ---------------------------------------------------------------------------
// Fixtures: a real temp project with a seeded store (docs + memory + a task),
// opened writable here to SEED, then re-opened READ-ONLY by the fallback.
// ---------------------------------------------------------------------------
let root: string;
let projectId: string;
let project: ProjectInfo;

const CONTEXT_DOC = 'the ContextEngine coordinates hybrid retrieval over the store';

async function seed(): Promise<void> {
  // Scaffold the .noir project (project.id + config.yml) so loadProjectInfo
  // resolves in-process (the fallback reads the project the same way the CLI
  // does). The embedder is configured `kind:none` → BM25-only: offline, no
  // model download, no network — the deterministic read path.
  mkdirSync(join(root, '.noir', 'store'), { recursive: true });
  writeFileSync(join(root, '.noir', 'project.id'), `${projectId}\n`, 'utf8');
  writeFileSync(
    join(root, '.noir', 'config.yml'),
    'host: claude\ncontext:\n  embedder:\n    kind: none\n',
    'utf8',
  );
  project = {
    id: projectId,
    name: 'g1-in-process',
    root,
    config: parseConfig({ host: 'claude', context: { embedder: { kind: 'none' } } }),
  };

  // Writable open: the daemon's normal role. Seed context + memory + a task.
  const store = await openStore({ projectId, root });
  const embedderCfg = { kind: 'none' } as const;
  const memory = createMemoryEngine({
    store,
    root,
    projectId,
    embed: createEmbedFn(embedderCfg).embed,
  });
  const workflow = new WorkflowEngine(store, root, projectId);

  // Save with a sessionId so the sessions rollup is populated (bumpSession).
  await memory.save({
    content: 'always pass ProjectId, never a filesystem path',
    sessionId: 'g1-session',
  });
  await workflow.startTask('g1-task', 'g1-task', 'full');

  // Seed a context doc directly (content-hash index of a nonexistent path would
  // be a no-op); the doc must be BM25-searchable in the read-only fallback.
  store.indexDoc({
    id: 'ctx:seed:1',
    source: 'codebase',
    content: CONTEXT_DOC,
    meta: { path: 'src/context.ts', parentDocId: 'h1' },
  });
  await store.close();
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'noir-g1-inprocess-'));
  projectId = `g1-${Math.random().toString(36).slice(2)}`;
  probeHolder.current = { running: false };
  vi.clearAllMocks();
  await seed();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Captured {
  out: string;
  err: string;
}
function captureStreams(): { capture: () => Captured; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const o = process.stdout.write.bind(process.stdout);
  const e = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: unknown) => {
    out.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: unknown) => {
    err.push(typeof c === 'string' ? c : String(c));
    return true;
  }) as typeof process.stderr.write;
  return {
    capture: () => ({ out: out.join(''), err: err.join('') }),
    restore: () => {
      process.stdout.write = o;
      process.stderr.write = e;
    },
  };
}

// ---------------------------------------------------------------------------
// The fallback helper itself
// ---------------------------------------------------------------------------
describe('withInProcessRead (daemon-client)', () => {
  it('opens a read-only store + context/memory/workflow engines and closes the store', async () => {
    const seen: string[] = [];
    await withInProcessRead({ project }, async (engines) => {
      seen.push('context', 'memory', 'workflow');
      expect(engines.context).toBeInstanceOf(ContextEngine);
      expect(engines.memory).toBeDefined();
      expect(engines.workflow).toBeInstanceOf(WorkflowEngine);
      // Reads work off the read-only handle.
      const hits = await engines.context.search('ContextEngine');
      expect(hits.results.length).toBeGreaterThan(0);
      return true;
    });
    expect(seen).toEqual(['context', 'memory', 'workflow']);
  });

  it('closes the store even when fn throws', async () => {
    await expect(
      withInProcessRead({ project }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// Wire-level: READS fall back, WRITES keep exit 4
// ---------------------------------------------------------------------------
describe('in-process read fallback — daemon down', () => {
  it("'context search foo' returns results (exit 0), not exit 4", async () => {
    const { capture, restore } = captureStreams();
    try {
      await contextSearch({ json: true, query: 'ContextEngine', project });
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        data: { hits: Array<{ path: string }>; mode: string };
      };
      expect(env.ok).toBe(true);
      expect(env.data.hits.length).toBeGreaterThan(0);
      expect(env.data.hits[0]?.path).toBe('src/context.ts');
    } finally {
      restore();
    }
    // The probe was consulted (daemon down) and the fallback ran in-process —
    // no daemon tool call happened.
    expect(probeDaemon).toHaveBeenCalled();
  });

  it("'memory recall foo' falls back to the in-process memory engine (exit 0)", async () => {
    const { capture, restore } = captureStreams();
    try {
      await memoryRecall({ json: true, query: 'ProjectId', project });
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        data: { hits: Array<{ content: string }> };
      };
      expect(env.ok).toBe(true);
      expect(env.data.hits.some((h) => h.content.includes('ProjectId'))).toBe(true);
    } finally {
      restore();
    }
  });

  it("'memory sessions' falls back to the in-process memory engine (exit 0)", async () => {
    const { capture, restore } = captureStreams();
    try {
      await memorySessions({ json: true, project });
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        data: { sessions: Array<{ id: string; count: number }> };
      };
      expect(env.ok).toBe(true);
      expect(env.data.sessions.length).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  it("'task status' falls back to the in-process workflow engine (exit 0)", async () => {
    const { capture, restore } = captureStreams();
    try {
      await taskStatus({ json: true, id: 'g1-task', project });
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        data: { taskId: string; phase: string };
      };
      expect(env.ok).toBe(true);
      expect(env.data.taskId).toBe('g1-task');
      expect(env.data.phase).toBe('intake');
    } finally {
      restore();
    }
  });

  it("'task new' still exits 4 (write requires the daemon — single writer)", async () => {
    // The daemon is down (probe false). A write must NOT open the store
    // in-process — it keeps the exit-4 daemon-down path.
    const { capture, restore } = captureStreams();
    try {
      await expect(taskNew({ json: true, slug: 'new-task', project })).rejects.toMatchObject({
        exitCode: 4,
      });
      const env = JSON.parse(capture().out) as {
        ok: boolean;
        error: { code: number };
      };
      expect(env.ok).toBe(false);
      expect(env.error.code).toBe(4);
    } finally {
      restore();
    }
  });
});
