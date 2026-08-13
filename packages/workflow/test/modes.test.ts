import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId, resolveArtifactPath } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from '../src/engine.js';
import { QUICK_SPEC_STUB, runQuick } from '../src/modes.js';
import type { GateResult } from '../src/types.js';

// Real-store setup (mirrors engine.test.ts): a fresh temp-dir DB per test so
// every KV + artifact assertion hits the actual SQLite / filesystem path.
let root: string;
let projectId: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-modes-'));
  projectId = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('runQuick (quick mode)', () => {
  it('lands at executing, writes a stub spec, and records the spec+plan gates as skipped', async () => {
    const store = await openStore({ projectId, root });
    try {
      const engine = new WorkflowEngine(store, root, projectId);
      await engine.startTask('task-1', 'add-login', 'quick');

      const landed = await runQuick(engine, 'task-1');

      expect(landed.state).toBe('executing');
      expect(landed.phase).toBe('execute');

      // stub spec written to .noir/specs/SP-<NNNN>-task-1-add-login.md
      const specFile = resolveArtifactPath(root, 'spec', { taskId: 'task-1', slug: 'add-login' });
      expect(existsSync(specFile)).toBe(true);
      const content = readFileSync(specFile, 'utf-8');
      expect(content).toContain(QUICK_SPEC_STUB);
      // frontmatter carries the C3 contract (ArtifactWriter.writeSpec shape)
      expect(content).toContain('kind: spec');
      expect(content).toContain('id: task-1');
      expect(content).toContain('slug: add-login');

      // skipped gates recorded (spec + plan) — observable, not silently dropped.
      // The audit KV is the source of truth; history mirrors it in-process.
      const audit = store.getState<GateResult[]>('audit:task-1');
      expect(audit).not.toBeNull();
      const skipped = audit?.filter((g) => g.decision === 'skipped') ?? [];
      expect(skipped).toHaveLength(2);
      expect(skipped[0]).toMatchObject({ phase: 'spec', decision: 'skipped' });
      expect(skipped[1]).toMatchObject({ phase: 'plan', decision: 'skipped' });
      // no approved/forced gates leaked into the quick path
      expect(audit?.filter((g) => g.decision !== 'skipped')).toHaveLength(0);
      expect(landed.history.filter((g) => g.decision === 'skipped')).toHaveLength(2);
    } finally {
      await store.close();
    }
  });

  it('does NOT skip the verify gate — quick mode leaves verify as the real discipline gate', async () => {
    const store = await openStore({ projectId, root });
    try {
      const engine = new WorkflowEngine(store, root, projectId);
      await engine.startTask('task-1', 'x', 'quick');
      await runQuick(engine, 'task-1'); // → executing

      // walk to done: execute → verify → document. The verify gate fires as
      // `approved` (the one real gate in quick mode — discipline lite).
      await engine.advance('task-1'); // → verifying
      const done = await engine.advance('task-1'); // → done (verify gate)
      expect(done.state).toBe('done');
      const verifyGate = done.history[done.history.length - 1];
      expect(verifyGate).toMatchObject({ phase: 'verify', decision: 'approved' });
    } finally {
      await store.close();
    }
  });

  it('honors a custom specBody override', async () => {
    const store = await openStore({ projectId, root });
    try {
      const engine = new WorkflowEngine(store, root, projectId);
      await engine.startTask('task-1', 'x', 'quick');
      await runQuick(engine, 'task-1', { specBody: 'my custom stub' });

      const content = readFileSync(
        resolveArtifactPath(root, 'spec', { taskId: 'task-1', slug: 'x' }),
        'utf-8',
      );
      expect(content).toContain('my custom stub');
    } finally {
      await store.close();
    }
  });

  it('throws when the task does not exist', async () => {
    const store = await openStore({ projectId, root });
    try {
      const engine = new WorkflowEngine(store, root, projectId);
      await expect(runQuick(engine, 'nope')).rejects.toThrow(/Unknown task: nope/);
    } finally {
      await store.close();
    }
  });
});
