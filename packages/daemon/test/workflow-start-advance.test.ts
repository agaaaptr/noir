// S9 review I1 — `workflow_start` / `workflow_advance` MCP tools (the daemon
// halves of `noir task new` / `task advance`). Round-trips the two NEW tools over
// an InMemoryTransport-linked client (mirrors workflow-status.test.ts). Pins:
//   • start → draft/intake, becomes the active task (workflow_status sees it);
//   • advance walks the FSM (clarify → specified fires the spec gate, approved);
//   • advance with `force` records a forced gate; `no active task` → clear envelope;
//   • a read-only (daemon-down) store refuses both writes up front (no crash).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createProjectId, type ProjectInfo } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNoirServer } from '../src/server.js';
import { buildWorkflowEngine } from '../src/workflow-seam.js';

let root: string;
let id: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-start-'));
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

describe('workflow_start / workflow_advance', () => {
  it('starts at intake, becomes active, then advances through the spec gate', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        dbPath: join(root, '.noir', 'store', `${id}.db`),
        storeDegraded: false,
        engine,
      });

      // start → draft/intake, becomes the active task.
      const started = (await callTool(server, 'workflow_start', {
        taskId: 't1',
        slug: 'add-login',
        mode: 'full',
      })) as Record<string, unknown>;
      expect(started.ok).toBe(true);
      expect(started.taskId).toBe('t1');
      expect(started.phase).toBe('intake');
      expect(started.state).toBe('draft');
      expect(started.mode).toBe('full');

      // advance (no taskId) → targets the active task → clarifying (no gate).
      const a1 = (await callTool(server, 'workflow_advance')) as Record<string, unknown>;
      expect(a1.ok).toBe(true);
      expect(a1.phase).toBe('clarify');
      expect(a1.state).toBe('clarifying');

      // advance → specified (spec gate fires, approved).
      const a2 = (await callTool(server, 'workflow_advance')) as Record<string, unknown>;
      expect(a2.ok).toBe(true);
      expect(a2.phase).toBe('spec');
      expect(a2.state).toBe('specified');
      expect(a2.history).toMatchObject([{ phase: 'spec', decision: 'approved' }]);

      // workflow_status (no taskId) sees the same active-task state — start made
      // it active and the advances persisted to the store KV.
      const status = (await callTool(server, 'workflow_status')) as Record<string, unknown>;
      expect(status.ok).toBe(true);
      expect(status.phase).toBe('spec');
    } finally {
      await store.close();
    }
  });

  it('defaults mode to full when omitted', async () => {
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
      const started = (await callTool(server, 'workflow_start', {
        taskId: 't2',
        slug: 'thing',
      })) as Record<string, unknown>;
      expect(started.ok).toBe(true);
      expect(started.mode).toBe('full');
    } finally {
      await store.close();
    }
  });

  it('advance with force records a forced gate carrying the reason', async () => {
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
      await callTool(server, 'workflow_start', { taskId: 't3', slug: 'x', mode: 'full' });
      await callTool(server, 'workflow_advance'); // intake → clarify
      // Force the spec gate (entering `specified`).
      const forced = (await callTool(server, 'workflow_advance', {
        force: { reason: 'design approved offline' },
      })) as Record<string, unknown>;
      expect(forced.ok).toBe(true);
      expect(forced.phase).toBe('spec');
      expect(forced.state).toBe('specified');
      expect(forced.history).toMatchObject([
        { phase: 'spec', decision: 'forced', reason: 'design approved offline' },
      ]);
    } finally {
      await store.close();
    }
  });

  it('advance with no active task → clear not-found envelope (no crash)', async () => {
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
      const res = (await callTool(server, 'workflow_advance')) as Record<string, unknown>;
      expect(res.ok).toBe(false);
      expect(String(res.error)).toMatch(/no active task/);
    } finally {
      await store.close();
    }
  });
});

describe('workflow_start / workflow_advance — degraded (read-only) store', () => {
  it('both refuse up front with a clear read-only envelope (no crash, no write)', async () => {
    // Seed writable, then reopen read-only — the daemon-down / FS-fallback shape.
    const seed = await openStore({ projectId: id, root });
    const seedEngine = buildWorkflowEngine(seed, root, id);
    await seedEngine.startTask('t1', 'x', 'full');
    await seed.close();

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

      // Both writes are fenced off up front — the engine is never asked to write.
      const startRes = (await callTool(server, 'workflow_start', {
        taskId: 't1',
        slug: 'x',
      })) as Record<string, unknown>;
      expect(startRes.ok).toBe(false);
      expect(startRes.degraded).toBe(true);
      expect(String(startRes.error)).toContain('read-only');

      const advRes = (await callTool(server, 'workflow_advance', {
        taskId: 't1',
      })) as Record<string, unknown>;
      expect(advRes.ok).toBe(false);
      expect(advRes.degraded).toBe(true);
      expect(String(advRes.error)).toContain('read-only');
    } finally {
      await ro.close();
    }
  });
});
