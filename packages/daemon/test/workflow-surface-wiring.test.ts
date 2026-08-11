// c4-surface-wiring — the new MCP tool surface: `taskClass` plumbing on
// `workflow_start`, quick-mode `runQuick` wiring, `workflow_resume`,
// `workflow_block`, `workflow_abandon`. Round-trips over InMemoryTransport
// (mirrors workflow-start-advance.test.ts). Pins:
//   • workflow_start with taskClass surfaces it in the status payload;
//   • mode:'quick' writes the stub spec + records skipped spec/plan gates;
//   • workflow_resume returns resumable:false for terminal / no-task, true for in-flight + blocked;
//   • workflow_block sets the task blocked with the reason; workflow_abandon is terminal;
//   • degraded (read-only) store refuses the writes up front (no crash).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  root = mkdtempSync(join(tmpdir(), 'noir-surface-'));
  id = createProjectId();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const project: ProjectInfo = {
  id: 'deadbeef',
  name: 'surface-demo',
  root,
  config: { host: 'claude', mode: 'full', daemon: { idleTimeoutSec: 900 } },
};

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
    return JSON.parse((block as { text: string }).text);
  } finally {
    await client.close();
  }
}

describe('workflow_start — taskClass plumbing (S1)', () => {
  it('accepts taskClass and surfaces it in the status payload', async () => {
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
        taskId: 't1',
        slug: 'add-login',
        taskClass: 'feature',
      })) as Record<string, unknown>;
      expect(started.ok).toBe(true);
      expect(started.taskClass).toBe('feature');
    } finally {
      await store.close();
    }
  });

  it('omits taskClass cleanly when not given (legacy/quick-task shape)', async () => {
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
      expect(started.taskClass).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe('workflow_start — quick mode wiring (S3)', () => {
  it('mode:quick fast-forwards to executing with a stub spec + skipped gates', async () => {
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
        taskId: 'q1',
        slug: 'spike-thing',
        mode: 'quick',
      })) as Record<string, unknown>;
      expect(started.ok).toBe(true);
      // runQuick fast-forwards draft → executing.
      expect(started.state).toBe('executing');
      expect(started.phase).toBe('execute');
      // The stub spec lands on disk (writeSpec wraps the body in frontmatter).
      const specPath = join(root, '.noir', 'specs', 'q1-spike-thing.md');
      expect(existsSync(specPath)).toBe(true);
      expect(readFileSync(specPath, 'utf8')).toContain('<quick-mode stub spec>');
      // The spec + plan gates are recorded as skipped (observable, not dropped).
      const history = started.history as Array<{ phase: string; decision: string }>;
      expect(history).toMatchObject([
        { phase: 'spec', decision: 'skipped' },
        { phase: 'plan', decision: 'skipped' },
      ]);
    } finally {
      await store.close();
    }
  });
});

describe('workflow_resume (S2)', () => {
  it('returns resumable:true + the task for an in-flight task', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('r1', 'task-a', 'full');
      await engine.advance('r1'); // draft → clarifying
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });
      const res = (await callTool(server, 'workflow_resume')) as Record<string, unknown>;
      expect(res.resumable).toBe(true);
      expect(res.taskId).toBe('r1');
      expect(res.state).toBe('clarifying');
    } finally {
      await store.close();
    }
  });

  it('returns resumable:true for a blocked task (blocked is NOT terminal)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('r2', 'task-b', 'full');
      await engine.setBlocked('r2', 'waiting on design');
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });
      const res = (await callTool(server, 'workflow_resume')) as Record<string, unknown>;
      expect(res.resumable).toBe(true);
      expect(res.state).toBe('blocked');
      expect(res.blockReason).toBe('waiting on design');
    } finally {
      await store.close();
    }
  });

  it('returns resumable:false when no active task exists', async () => {
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
      const res = (await callTool(server, 'workflow_resume')) as Record<string, unknown>;
      expect(res.resumable).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('returns resumable:false for a terminal (done) task', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      // Walk a task all the way to done (terminal).
      await engine.startTask('r3', 'task-c', 'quick');
      await engine.advance('r3'); // draft → clarifying
      await engine.advance('r3'); // → specified (spec gate)
      await engine.advance('r3'); // → planned (plan gate)
      await engine.advance('r3'); // → executing
      await engine.advance('r3'); // → verifying
      await engine.advance('r3'); // → done (verify gate, terminal)
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });
      const res = (await callTool(server, 'workflow_resume')) as Record<string, unknown>;
      expect(res.resumable).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe('workflow_block / workflow_abandon (S4)', () => {
  it('workflow_block sets the active task blocked with the reason', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('b1', 'task-d', 'full');
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });
      const res = (await callTool(server, 'workflow_block', {
        reason: 'CI is red',
      })) as Record<string, unknown>;
      expect(res.ok).toBe(true);
      expect(res.state).toBe('blocked');
      expect(res.blockReason).toBe('CI is red');
    } finally {
      await store.close();
    }
  });

  it('workflow_abandon makes the active task terminal', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const engine = buildWorkflowEngine(store, root, id);
      await engine.startTask('b2', 'task-e', 'full');
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store,
        engine,
      });
      const res = (await callTool(server, 'workflow_abandon')) as Record<string, unknown>;
      expect(res.ok).toBe(true);
      expect(res.state).toBe('abandoned');
    } finally {
      await store.close();
    }
  });

  it('block/abandon refuse up front on a degraded (read-only) store', async () => {
    // Seed writable, then reopen read-only.
    const seed = await openStore({ projectId: id, root });
    const seedEngine = buildWorkflowEngine(seed, root, id);
    await seedEngine.startTask('b3', 'task-f', 'full');
    await seed.close();

    const ro = await openStore({ projectId: id, root, readonly: true });
    try {
      const engine = buildWorkflowEngine(ro, root, id);
      const server = createNoirServer({
        project: { ...project, id },
        transport: 'stdio',
        daemon: false,
        store: ro,
        storeDegraded: true,
        engine,
      });
      const blockRes = (await callTool(server, 'workflow_block', {
        reason: 'x',
      })) as Record<string, unknown>;
      expect(blockRes.ok).toBe(false);
      expect(blockRes.degraded).toBe(true);
      expect(String(blockRes.error)).toContain('read-only');

      const abandonRes = (await callTool(server, 'workflow_abandon')) as Record<string, unknown>;
      expect(abandonRes.ok).toBe(false);
      expect(abandonRes.degraded).toBe(true);
      expect(String(abandonRes.error)).toContain('read-only');
    } finally {
      await ro.close();
    }
  });
});
