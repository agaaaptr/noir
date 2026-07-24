import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildWorkflowStatus, createNoirServer } from '../src/server.js';
import { buildWorkflowEngine } from '../src/workflow-seam.js';

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-status-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'wf-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

/** Drive an in-process MCP round-trip: link a client to the server and call one tool. */
async function callTool(
  server: ReturnType<typeof createNoirServer>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
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
    return JSON.parse((block as { text: string }).text);
  } finally {
    await client.close();
  }
}

describe('workflow_status', () => {
  it('returns phase/state/history for a task advanced to spec, and history carries the spec gate', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      // draft/intake → clarify → specified (spec gate fires on landing).
      await engine.startTask('t1', 'add-login', 'full');
      await engine.advance('t1'); // draft → clarifying (no gate)
      await engine.advance('t1'); // clarifying → specified (spec gate approved)

      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: false,
        engine,
      });

      const parsed = (await callTool(server, 'workflow_status', { taskId: 't1' })) as Record<
        string,
        unknown
      >;

      expect(parsed.ok).toBe(true);
      expect(parsed.taskId).toBe('t1');
      expect(parsed.phase).toBe('spec');
      expect(parsed.state).toBe('specified');
      expect(parsed.mode).toBe('full');
      // Past the spec gate, the next gate ahead is `plan`.
      expect(parsed.nextGate).toBe('plan');
      expect(Array.isArray(parsed.history)).toBe(true);
      expect((parsed.history as unknown[]).length).toBe(1);
      expect(parsed.history).toMatchObject([{ phase: 'spec', decision: 'approved' }]);
    } finally {
      await store.close();
    }
  });

  it('defaults to the active task when taskId is omitted (reads workflow:active)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('t-active', 'thing', 'full');

      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });

      const parsed = (await callTool(server, 'workflow_status')) as Record<string, unknown>;
      expect(parsed.ok).toBe(true);
      expect(parsed.taskId).toBe('t-active');
      expect(parsed.phase).toBe('intake');
    } finally {
      await store.close();
    }
  });

  it('reports a clear not-found when the task is unknown (no crash)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });

      const parsed = (await callTool(server, 'workflow_status', { taskId: 'nope' })) as Record<
        string,
        unknown
      >;
      expect(parsed.ok).toBe(false);
      expect(parsed.taskId).toBe('nope');
    } finally {
      await store.close();
    }
  });

  it('buildWorkflowStatus surfaces null nextGate for terminal/blocked states', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('t1', 'x', 'full');
      await engine.setBlocked('t1', 'waiting on design');

      const status = buildWorkflowStatus(engine, 't1', false);
      expect(status?.state).toBe('blocked');
      expect(status?.nextGate).toBeNull();
    } finally {
      await store.close();
    }
  });
});

describe('checkpoint', () => {
  it('save then restore round-trips the in-flight task state', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('t1', 'add-login', 'full');
      await engine.advance('t1'); // → clarifying
      await engine.advance('t1'); // → specified (spec gate)

      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: false,
        engine,
      });

      const saved = (await callTool(server, 'checkpoint', {
        action: 'save',
        taskId: 't1',
      })) as Record<string, unknown>;
      expect(saved.ok).toBe(true);
      expect(saved.action).toBe('save');
      expect(saved.phase).toBe('spec');

      const restored = (await callTool(server, 'checkpoint', {
        action: 'restore',
        taskId: 't1',
      })) as Record<string, unknown>;
      // Round-trip: restored state matches what was saved.
      expect(restored.ok).toBe(true);
      expect(restored.action).toBe('restore');
      expect(restored.taskId).toBe('t1');
      expect(restored.phase).toBe('spec');
      expect(restored.state).toBe('specified');
      expect(restored.history).toMatchObject([{ phase: 'spec', decision: 'approved' }]);
    } finally {
      await store.close();
    }
  });
});

describe('degraded (read-only store) — tools stay up, save surfaces a clear error', () => {
  it('workflow_status reads fine; checkpoint save fails cleanly without crashing', async () => {
    // Seed with a writable handle: start a task + advance to spec, then close.
    const seed = await openStore({ projectId: id, root });
    const seedEngine = buildWorkflowEngine(seed, root, id);
    await seedEngine.startTask('t1', 'add-login', 'full');
    await seedEngine.advance('t1');
    await seedEngine.advance('t1'); // → specified (spec gate)
    await seed.close();

    // Reopen read-only — the daemon-down / FS-fallback shape. The engine built
    // on this handle can READ (status / activeTaskId) but any write throws
    // "store is read-only (daemon down)".
    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const engine = buildWorkflowEngine(ro, root, id);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store: ro,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: true,
        engine,
      });

      // Read path keeps working — the degraded promise.
      const status = (await callTool(server, 'workflow_status', { taskId: 't1' })) as Record<
        string,
        unknown
      >;
      expect(status.ok).toBe(true);
      expect(status.phase).toBe('spec');
      expect(status.degraded).toBe(true);

      // Save must fail cleanly (no throw, no crash) and flag degraded.
      const saved = (await callTool(server, 'checkpoint', {
        action: 'save',
        taskId: 't1',
      })) as Record<string, unknown>;
      expect(saved.ok).toBe(false);
      expect(saved.degraded).toBe(true);
      expect(String(saved.error)).toContain('read-only');

      // Restore (a read) still works on the degraded handle.
      const restored = (await callTool(server, 'checkpoint', {
        action: 'restore',
        taskId: 't1',
      })) as Record<string, unknown>;
      expect(restored.ok).toBe(true);
      expect(restored.phase).toBe('spec');
    } finally {
      await ro.close();
    }
  });
});
