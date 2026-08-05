// `context_index --force` full-reindex tests (task E1).
//
// Unit-level: rather than building a real ContextEngine (which needs a store +
// embedder), we stub the engine with `vi.fn`s and drive `context_index` through
// an in-process InMemoryTransport round-trip (same harness as workflow-status /
// context-tools tests, but with no store at all). This pins the daemon contract:
//   • force:true  → handler calls `context.reindex()` (NOT indexPaths);
//   • force:false / omitted → handler stays on the incremental `indexPaths` path;
//   • the degraded (read-only store) fence still wins even when force:true.
// Offline by construction (NFR-2) — no HTTP, no stdio, no native embedder.

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNoirServer } from '../src/server.js';

let root: string;
let id: string;

beforeEach(() => {
  root = `/tmp/noir-context-force-${id}`;
  id = createProjectId();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'ctx-force-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/** A minimal fake {@link ContextEngine} surface (only what the handler touches). */
function fakeContext() {
  const indexPaths = vi.fn(async () => ({
    indexed: 1,
    skipped: 0,
    deleted: 0,
    degraded: false,
    failed: 0,
    totalChunks: 1,
  }));
  const reindex = vi.fn(async () => ({
    indexed: 3,
    skipped: 0,
    deleted: 2,
    degraded: false,
    failed: 0,
    totalChunks: 3,
  }));
  return {
    indexPaths,
    reindex,
    search: vi.fn(),
    status: vi.fn(),
  };
}

/** Drive one in-process MCP round-trip and return the parsed tool payload. */
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

describe('context_index --force (daemon contract)', () => {
  it('force:true calls context.reindex() (full reindex), not indexPaths', async () => {
    const context = fakeContext();
    const server = createNoirServer({
      project: { ...project, id },
      transport: 'stdio',
      daemon: false,
      context: context as unknown as Parameters<typeof createNoirServer>[0]['context'],
    });

    const res = await callTool(server, 'context_index', { force: true });

    expect(context.indexPaths).not.toHaveBeenCalled();
    expect(context.reindex).toHaveBeenCalledTimes(1);
    expect(context.reindex).toHaveBeenCalledWith();
    expect(res.ok).toBe(true);
    expect(res.deleted).toBe(2);
  });

  it('force absent → incremental indexPaths with the default [.]', async () => {
    const context = fakeContext();
    const server = createNoirServer({
      project: { ...project, id },
      transport: 'stdio',
      daemon: false,
      context: context as unknown as Parameters<typeof createNoirServer>[0]['context'],
    });

    const res = await callTool(server, 'context_index', {});

    expect(context.reindex).not.toHaveBeenCalled();
    expect(context.indexPaths).toHaveBeenCalledTimes(1);
    expect(context.indexPaths).toHaveBeenCalledWith(['.']);
    expect(res.ok).toBe(true);
  });

  it('force:false → incremental indexPaths (same as absent)', async () => {
    const context = fakeContext();
    const server = createNoirServer({
      project: { ...project, id },
      transport: 'stdio',
      daemon: false,
      context: context as unknown as Parameters<typeof createNoirServer>[0]['context'],
    });

    const res = await callTool(server, 'context_index', { force: false, paths: ['src'] });

    expect(context.reindex).not.toHaveBeenCalled();
    expect(context.indexPaths).toHaveBeenCalledTimes(1);
    expect(context.indexPaths).toHaveBeenCalledWith(['src']);
    expect(res.ok).toBe(true);
  });

  it('force:true with paths still honors a full reindex (paths are a no-op for reindex)', async () => {
    const context = fakeContext();
    const server = createNoirServer({
      project: { ...project, id },
      transport: 'stdio',
      daemon: false,
      context: context as unknown as Parameters<typeof createNoirServer>[0]['context'],
    });

    const res = await callTool(server, 'context_index', { force: true, paths: ['src'] });

    expect(context.reindex).toHaveBeenCalledTimes(1);
    expect(context.indexPaths).not.toHaveBeenCalled();
    expect(res.ok).toBe(true);
  });

  it('AC-5: read-only (daemon-down) store — force:true still returns the degraded envelope', async () => {
    const context = fakeContext();
    const server = createNoirServer({
      project: { ...project, id },
      transport: 'stdio',
      daemon: false,
      storeDegraded: true,
      context: context as unknown as Parameters<typeof createNoirServer>[0]['context'],
    });

    const res = await callTool(server, 'context_index', { force: true });

    expect(res.ok).toBe(false);
    expect(res.degraded).toBe(true);
    expect((res.error as string).toLowerCase()).toContain('read-only');
    // The fence fires before any engine call — neither path runs.
    expect(context.reindex).not.toHaveBeenCalled();
    expect(context.indexPaths).not.toHaveBeenCalled();
  });
});
