import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { resumeTask } from '../src/modes.js';

// Cross-session resume: the store is closed and a FRESH handle is opened
// against the same on-disk DB, proving state survives a process/session break.
let root: string;
let projectId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-resume-'));
  projectId = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resumeTask (cross-session resume)', () => {
  it('reconstructs the in-flight TaskState across a store close/reopen', async () => {
    // Session 1: start a task and advance to `specified` (spec gate passed).
    const store = await openStore({ projectId, root });
    const engine = new WorkflowEngine(store, root, projectId);
    await engine.startTask('task-1', 'add-login', 'full');
    await engine.advance('task-1'); // → clarifying
    await engine.advance('task-1'); // → specified (spec gate)
    await store.close();

    // Session 2: a fresh store handle against the same on-disk DB.
    const reopened = await openStore({ projectId, root });
    try {
      const resumed = await resumeTask(reopened);
      expect(resumed).not.toBeNull();
      expect(resumed?.taskId).toBe('task-1');
      expect(resumed?.phase).toBe('spec');
      expect(resumed?.state).toBe('specified');
      expect(resumed?.slug).toBe('add-login');
      expect(resumed?.mode).toBe('full');
    } finally {
      await reopened.close();
    }
  });

  it('returns null when there is no active task (fresh project)', async () => {
    const store = await openStore({ projectId, root });
    try {
      expect(await resumeTask(store)).toBeNull();
    } finally {
      await store.close();
    }
  });

  it('returns null when the active task is terminal (done — nothing to resume)', async () => {
    const store = await openStore({ projectId, root });
    const engine = new WorkflowEngine(store, root, projectId);
    await engine.startTask('task-1', 'x', 'full');
    for (let i = 0; i < 6; i++) await engine.advance('task-1'); // → done
    expect(engine.status('task-1')?.state).toBe('done');
    await store.close();

    const reopened = await openStore({ projectId, root });
    try {
      expect(await resumeTask(reopened)).toBeNull();
    } finally {
      await reopened.close();
    }
  });

  it('returns the task when it is blocked (blocked is in-flight / resumable)', async () => {
    const store = await openStore({ projectId, root });
    const engine = new WorkflowEngine(store, root, projectId);
    await engine.startTask('task-1', 'x', 'full');
    await engine.setBlocked('task-1', 'waiting on design');
    await store.close();

    const reopened = await openStore({ projectId, root });
    try {
      const resumed = await resumeTask(reopened);
      expect(resumed?.state).toBe('blocked');
      expect(resumed?.blockReason).toBe('waiting on design');
    } finally {
      await reopened.close();
    }
  });
});
