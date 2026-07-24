import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import type { GateResult, TaskState } from '../src/types.js';

// Real-store setup (mirrors gates.test.ts): a fresh temp-dir DB per test so
// every KV assertion hits the actual SQLite path, not a mock.
let root: string;
let projectId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-engine-'));
  projectId = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('WorkflowEngine', () => {
  describe('startTask', () => {
    it('creates a task in draft/intake, persists workflow:<id> and sets workflow:active', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        const task = await engine.startTask('task-1', 'add-login', 'full');

        expect(task.state).toBe('draft');
        expect(task.phase).toBe('intake');
        expect(task.mode).toBe('full');
        expect(task.history).toEqual([]);
        expect(task.updatedAt).toBeTypeOf('number');

        // persisted to KV
        expect(store.getState<TaskState>('workflow:task-1')?.taskId).toBe('task-1');
        // active pointer
        expect(store.getState<string>('workflow:active')).toBe('task-1');
      } finally {
        await store.close();
      }
    });

    it('startTask is idempotent-ish: re-starting overwrites the task and re-points active', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'first', 'full');
        const again = await engine.startTask('task-1', 'second', 'quick');
        expect(again.slug).toBe('second');
        expect(again.mode).toBe('quick');
        expect(store.getState<TaskState>('workflow:task-1')?.slug).toBe('second');
      } finally {
        await store.close();
      }
    });
  });

  describe('advance — happy path + observable gates', () => {
    it('advance draft→clarifying records no gate; clarifying→specified records approved spec gate', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'add-login', 'full');

        const clarifying = await engine.advance('task-1');
        expect(clarifying.state).toBe('clarifying');
        expect(clarifying.phase).toBe('clarify');
        expect(clarifying.history).toHaveLength(0); // clarify is not a gate phase

        const specified = await engine.advance('task-1');
        expect(specified.state).toBe('specified');
        expect(specified.phase).toBe('spec');
        expect(specified.history).toHaveLength(1);
        expect(specified.history[0]).toMatchObject({ phase: 'spec', decision: 'approved' });

        // audit KV mirrors history (recordGate wrote to audit:task-1)
        const audit = store.getState<GateResult[]>('audit:task-1');
        expect(audit).toHaveLength(1);
        expect(audit?.[0]).toMatchObject({ phase: 'spec', decision: 'approved' });
      } finally {
        await store.close();
      }
    });

    it('advance specified→planned records the approved plan gate', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying
        await engine.advance('task-1'); // → specified (spec gate)
        const planned = await engine.advance('task-1'); // → planned (plan gate)

        expect(planned.state).toBe('planned');
        expect(planned.history).toHaveLength(2);
        expect(planned.history[1]).toMatchObject({ phase: 'plan', decision: 'approved' });
      } finally {
        await store.close();
      }
    });

    it('verify gate fires when entering done (target phase is document; gate phase is verify)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        for (let i = 0; i < 5; i++) await engine.advance('task-1'); // walk to verifying
        expect(engine.status('task-1')?.state).toBe('verifying');

        const done = await engine.advance('task-1'); // verifying → done (verify gate)
        expect(done.state).toBe('done');
        expect(done.phase).toBe('document');
        const verifyGate = done.history[done.history.length - 1];
        expect(verifyGate).toMatchObject({ phase: 'verify', decision: 'approved' });
      } finally {
        await store.close();
      }
    });
  });

  describe('--force (escapable gates)', () => {
    it('records a forced gate carrying the reason when --force is supplied at a gate', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1', {
          force: { reason: 'spec good enough for spike' },
        });
        expect(specified.history).toHaveLength(1);
        expect(specified.history[0]).toMatchObject({
          phase: 'spec',
          decision: 'forced',
          reason: 'spec good enough for spike',
        });

        // audit KV carries the forced decision + reason
        const audit = store.getState<GateResult[]>('audit:task-1');
        expect(audit?.[0]?.decision).toBe('forced');
        expect(audit?.[0]?.reason).toBe('spec good enough for spike');
      } finally {
        await store.close();
      }
    });

    it('throws if --force is supplied without a (non-empty) reason — missing, empty, or whitespace', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying

        // missing reason key entirely (the MCP/JSON path)
        await expect(engine.advance('task-1', { force: {} })).rejects.toThrow(
          '--force requires a reason',
        );
        // empty string
        await expect(engine.advance('task-1', { force: { reason: '' } })).rejects.toThrow(
          '--force requires a reason',
        );
        // whitespace only
        await expect(engine.advance('task-1', { force: { reason: '   ' } })).rejects.toThrow(
          '--force requires a reason',
        );

        // nothing was recorded — state is unchanged and no audit entry exists
        expect(engine.status('task-1')?.state).toBe('clarifying');
        expect(store.getState<GateResult[]>('audit:task-1')).toBeNull();
      } finally {
        await store.close();
      }
    });

    it('force on a non-gate advance does not record a gate (reason is still required)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        const clarifying = await engine.advance('task-1', { force: { reason: 'moving along' } });

        expect(clarifying.state).toBe('clarifying');
        expect(clarifying.history).toHaveLength(0); // clarify is not a gate phase
        expect(store.getState<GateResult[]>('audit:task-1')).toBeNull();
      } finally {
        await store.close();
      }
    });
  });

  describe('jump-to-phase (opts.to)', () => {
    it('jumps past FSM edges and records jumpEntry (draft → verify)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');

        // draft → verify is illegal via the FSM, but opts.to is the escape hatch.
        const landed = await engine.advance('task-1', { to: 'verify' });
        expect(landed.state).toBe('verifying');
        expect(landed.phase).toBe('verify');
        expect(landed.jumpEntry).toBe('verify');
        // verify (in-progress) is not a gate-landing state — the verify gate fires
        // entering `done`, not `verifying` — so no gate is recorded.
        expect(landed.history).toHaveLength(0);
      } finally {
        await store.close();
      }
    });

    it('jump to a gate-landing state (done) records the verify gate AND jumpEntry', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');

        const landed = await engine.advance('task-1', { to: 'document' });
        expect(landed.state).toBe('done');
        expect(landed.phase).toBe('document');
        expect(landed.jumpEntry).toBe('document');
        // entering `done` always fires the verify gate (the gate admits `done`).
        expect(landed.history).toHaveLength(1);
        expect(landed.history[0]).toMatchObject({ phase: 'verify', decision: 'approved' });
      } finally {
        await store.close();
      }
    });
  });

  describe('illegal advance', () => {
    it('throws when there is no next phase from a terminal state (done)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        for (let i = 0; i < 6; i++) await engine.advance('task-1'); // → done
        expect(engine.status('task-1')?.state).toBe('done');

        await expect(engine.advance('task-1')).rejects.toThrow(/No next phase from state done/);
      } finally {
        await store.close();
      }
    });

    it('throws when advancing an unknown task', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await expect(engine.advance('nope')).rejects.toThrow(/Unknown task: nope/);
      } finally {
        await store.close();
      }
    });
  });

  describe('status + checkpoint', () => {
    it('status returns null for an unknown task and the TaskState otherwise', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        expect(engine.status('nope')).toBeNull();

        await engine.startTask('task-1', 'x', 'full');
        expect(engine.status('task-1')?.phase).toBe('intake');
      } finally {
        await store.close();
      }
    });

    it('checkpoint re-flushes the current state to KV (updatedAt advances)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        const before = engine.status('task-1')?.updatedAt ?? 0;

        await new Promise((resolve) => setTimeout(resolve, 5));
        await engine.checkpoint('task-1');

        const after = engine.status('task-1')?.updatedAt ?? 0;
        expect(after).toBeGreaterThan(before);
      } finally {
        await store.close();
      }
    });
  });

  describe('blocked / abandoned (set directly, not via the FSM)', () => {
    it('setBlocked sets state=blocked directly and stores the reason', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');

        const blocked = await engine.setBlocked('task-1', 'waiting on design');
        expect(blocked.state).toBe('blocked');
        expect(blocked.blockReason).toBe('waiting on design');
        expect(engine.status('task-1')?.state).toBe('blocked');
        expect(engine.status('task-1')?.blockReason).toBe('waiting on design');
      } finally {
        await store.close();
      }
    });

    it('abandon sets state=abandoned directly', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');

        const abandoned = await engine.abandon('task-1');
        expect(abandoned.state).toBe('abandoned');
        expect(engine.status('task-1')?.state).toBe('abandoned');
      } finally {
        await store.close();
      }
    });
  });
});
