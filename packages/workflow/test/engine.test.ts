import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writePrd } from '../src/artifacts.js';
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

    it('activeTaskId returns the most-recently-started task (workflow:active), or null', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        expect(engine.activeTaskId()).toBeNull();

        await engine.startTask('task-1', 'a', 'full');
        expect(engine.activeTaskId()).toBe('task-1');

        // Starting another task re-points `workflow:active` at it.
        await engine.startTask('task-2', 'b', 'quick');
        expect(engine.activeTaskId()).toBe('task-2');
      } finally {
        await store.close();
      }
    });
  });

  describe('skip (quick-mode gates: skipped is RECORDED, never dropped)', () => {
    it('records the landing gate as skipped when opts.skip is supplied at a gate', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'quick');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1', { skip: true });
        expect(specified.history).toHaveLength(1);
        expect(specified.history[0]).toMatchObject({ phase: 'spec', decision: 'skipped' });
        // skipped carries no reason (only `forced` does)
        expect(specified.history[0].reason).toBeUndefined();

        // audit KV mirrors history with the skipped decision
        const audit = store.getState<GateResult[]>('audit:task-1');
        expect(audit?.[0]).toMatchObject({ phase: 'spec', decision: 'skipped' });
      } finally {
        await store.close();
      }
    });

    it('skip on a non-gate advance records nothing (clarify is not a gate phase)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'quick');
        const clarifying = await engine.advance('task-1', { skip: true });
        expect(clarifying.state).toBe('clarifying');
        expect(clarifying.history).toHaveLength(0);
        expect(store.getState<GateResult[]>('audit:task-1')).toBeNull();
      } finally {
        await store.close();
      }
    });

    it('rejects combining skip with force (mutually exclusive gate decisions)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying

        await expect(
          engine.advance('task-1', { skip: true, force: { reason: 'x' } }),
        ).rejects.toThrow(/cannot combine --force and skip/);
        // nothing recorded on a rejected advance
        expect(engine.status('task-1')?.state).toBe('clarifying');
        expect(store.getState<GateResult[]>('audit:task-1')).toBeNull();
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

    // SetBlocked now requires a non-empty (post-trim) reason when one is
    // supplied — mirrors --force's whitespace rejection. Omitting reason stays
    // valid (clears nothing, just flips state).
    it('setBlocked rejects a whitespace-only reason (consistent with --force)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');

        await expect(engine.setBlocked('task-1', '   ')).rejects.toThrow(/non-empty/);
        await expect(engine.setBlocked('task-1', '\t\n')).rejects.toThrow(/non-empty/);
        // State is unchanged on rejection (still draft/intake).
        expect(engine.status('task-1')?.state).toBe('draft');

        // No-reason call stays valid — flips state, leaves blockReason unset.
        const blocked = await engine.setBlocked('task-1');
        expect(blocked.state).toBe('blocked');
        expect(blocked.blockReason).toBeUndefined();

        // A reason with surrounding whitespace is trimmed + accepted.
        const blocked2 = await engine.setBlocked('task-1', '  waiting on design  ');
        expect(blocked2.blockReason).toBe('waiting on design');
      } finally {
        await store.close();
      }
    });
  });

  // Debt-batch A — collapse the dual source of truth. The audit:<id> KV is
  // AUTHORITATIVE (§11 OQ-5); task.history is a DERIVED view regenerated
  // from it on every advance and every status() read. No drift, one timestamp.
  describe('history is derived from the authoritative audit KV', () => {
    it('advance mirrors the audit KV exactly (single timestamp, no drift)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying (no gate)
        const specified = await engine.advance('task-1'); // → specified (spec gate)

        const audit = store.getState<GateResult[]>('audit:task-1') ?? [];
        expect(audit).toHaveLength(1);
        // Single source, single timestamp: history === audit, byte-for-byte.
        expect(specified.history).toEqual(audit);
        expect(specified.history[0]?.at).toBe(audit[0]?.at);

        // Round-trip through status(): the read also derives from the KV.
        const reread = engine.status('task-1');
        expect(reread?.history).toEqual(audit);
      } finally {
        await store.close();
      }
    });

    it('status() re-derives history from the audit KV (catches external mutation)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying
        await engine.advance('task-1'); // → specified
        expect(engine.status('task-1')?.history).toHaveLength(1);

        // Simulate an external mutation (manual KV edit, audit import, …).
        const mutated: GateResult[] = [
          { phase: 'spec', decision: 'forced', reason: 'external override', at: 12345 },
        ];
        store.setState<GateResult[]>('audit:task-1', mutated);

        // status() picks up the new KV without an intervening advance.
        const reread = engine.status('task-1');
        expect(reread?.history).toEqual(mutated);
      } finally {
        await store.close();
      }
    });
  });

  // Debt-batch A — soft, escapable PRD recommendation at the spec gate.
  // The advance ALWAYS proceeds (never a hard block); the recommendation is
  // folded into the recorded spec gate's `reason` (observable in the audit).
  // --force <reason> is the explicit-override path; quick mode + unlisted
  // taskClasses skip the check entirely.
  describe('soft PRD recommendation at the spec gate', () => {
    it('records the PRD recommendation on the spec gate when a feature task has no PRD', async () => {
      const store = await openStore({ projectId, root });
      try {
        // Disable research hint for PRD-isolation test.
        const engine = new WorkflowEngine(store, root, projectId, {
          prd: { mandatoryFor: ['feature', 'epic'] },
          verify: { required: false, retryBudget: 2 },
          research: { recommendFor: [], requireSource: true },
        });
        await engine.startTask('task-1', 'add-login', 'full', 'feature');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1'); // → specified (spec gate)
        // The advance PROCEEDED — never a hard block.
        expect(specified.state).toBe('specified');
        // The spec gate carries the recommendation note on its `reason`.
        const specGate = specified.history[specified.history.length - 1];
        expect(specGate?.decision).toBe('approved');
        expect(specGate?.reason).toMatch(/PRD recommended for feature/);
        expect(specGate?.reason).toMatch(/--force/);

        // Same content is observable in the authoritative audit KV.
        const audit = store.getState<GateResult[]>('audit:task-1');
        expect(audit?.[audit.length - 1]?.reason).toMatch(/PRD recommended for feature/);
      } finally {
        await store.close();
      }
    });

    it('records the spec gate CLEAN (no reason) when a PRD artifact exists', async () => {
      const store = await openStore({ projectId, root });
      try {
        // Disable research hint for PRD-isolation test.
        const engine = new WorkflowEngine(store, root, projectId, {
          prd: { mandatoryFor: ['feature', 'epic'] },
          verify: { required: false, retryBudget: 2 },
          research: { recommendFor: [], requireSource: true },
        });
        await engine.startTask('task-1', 'add-login', 'full', 'feature');
        writePrd(root, 'task-1', 'add-login', '# Problem\nUsers cannot log in.');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1'); // → specified
        const specGate = specified.history[specified.history.length - 1];
        expect(specGate?.decision).toBe('approved');
        expect(specGate?.reason).toBeUndefined(); // clean — PRD present
      } finally {
        await store.close();
      }
    });

    it('--force overrides the recommendation and records decision=forced with the user reason', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'add-login', 'full', 'feature');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1', {
          force: { reason: 'spike — PRD deferred' },
        });
        const specGate = specified.history[specified.history.length - 1];
        // The user's reason wins (NOT the recommendation note) — force is the
        // explicit-override path; the audit shows the user accepted + overrode.
        expect(specGate?.decision).toBe('forced');
        expect(specGate?.reason).toBe('spike — PRD deferred');
      } finally {
        await store.close();
      }
    });

    it('quick-mode tasks skip the check entirely (no recommendation, even with no PRD)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'quick', 'feature');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1', { skip: true }); // → specified
        const specGate = specified.history[specified.history.length - 1];
        // Quick mode: decision=skipped, no reason — the PRD check is bypassed.
        expect(specGate?.decision).toBe('skipped');
        expect(specGate?.reason).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('tasks with an unlisted taskClass skip the check (bugfix default)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'fix-crash', 'full', 'bugfix');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1'); // → specified
        const specGate = specified.history[specified.history.length - 1];
        expect(specGate?.decision).toBe('approved');
        expect(specGate?.reason).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('tasks with NO taskClass skip the check (legacy callers — backward compat)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        // Legacy 3-arg startTask: no taskClass ⇒ no soft gate ever fires.
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1'); // → specified
        const specGate = specified.history[specified.history.length - 1];
        expect(specGate?.decision).toBe('approved');
        expect(specGate?.reason).toBeUndefined();
      } finally {
        await store.close();
      }
    });

    it('honors a user-overridden mandatoryFor list via the 4th constructor arg', async () => {
      const store = await openStore({ projectId, root });
      try {
        // User widens the recommendation to enhancement.
        const engine = new WorkflowEngine(store, root, projectId, {
          prd: { mandatoryFor: ['enhancement'] },
          verify: { required: false, retryBudget: 2 },
          research: { recommendFor: [], requireSource: true },
        });
        await engine.startTask('task-1', 'x', 'full', 'enhancement');
        await engine.advance('task-1'); // → clarifying

        const specified = await engine.advance('task-1'); // → specified
        const specGate = specified.history[specified.history.length - 1];
        expect(specGate?.reason).toMatch(/PRD recommended for enhancement/);

        // `feature` is no longer in the list — a feature task now skips.
        await engine.startTask('task-2', 'y', 'full', 'feature');
        await engine.advance('task-2'); // → clarifying
        const specified2 = await engine.advance('task-2'); // → specified
        const specGate2 = specified2.history[specified2.history.length - 1];
        expect(specGate2?.reason).toBeUndefined();
      } finally {
        await store.close();
      }
    });
  });

  // Debt-batch A — jump-to-current-phase was a no-op that re-stamped the
  // audit (a duplicate landing-gate entry). Guarded now: a jump whose target
  // equals the current phase returns the task unchanged.
  describe('jump-to-current-phase is a no-op (no spurious gate)', () => {
    it('returns the task unchanged when opts.to === task.phase (no gate re-stamp)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying
        await engine.advance('task-1'); // → specified (spec gate)
        const before = engine.status('task-1');
        const historyBefore = before?.history.length ?? 0;

        // Jump to the CURRENT phase (spec) — should be a no-op.
        const same = await engine.advance('task-1', { to: 'spec' });
        expect(same.state).toBe('specified');
        expect(same.phase).toBe('spec');
        // No new gate entry — the audit is unchanged.
        expect(same.history).toHaveLength(historyBefore);
        const audit = store.getState<GateResult[]>('audit:task-1');
        expect(audit).toHaveLength(historyBefore);
      } finally {
        await store.close();
      }
    });
  });

  // Debt-batch A — checkpoint save was vestigial (just bumped updatedAt,
  // which advance already does; resumeTask consumes nothing from it). Now WIRED
  // to the audit JSON export — `checkpoint` flushes `.noir/audit/
  // <taskId>.json` (writeAuditExport) so the public MCP tool leaves a real
  // cross-tool artifact, not just a timestamp bump.
  describe('checkpoint flushes the audit JSON export to disk', () => {
    it('writes .noir/audit/<taskId>.json containing the audit KV (§11 OQ-5)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await engine.startTask('task-1', 'x', 'full');
        await engine.advance('task-1'); // → clarifying
        await engine.advance('task-1'); // → specified (spec gate)

        const auditFile = join(root, '.noir', 'audit', 'task-1.json');
        expect(existsSync(auditFile)).toBe(false);

        await engine.checkpoint('task-1');

        // The audit JSON now exists on disk and carries the spec gate entry.
        expect(existsSync(auditFile)).toBe(true);
        const raw = readFileSync(auditFile, 'utf8');
        const exported = JSON.parse(raw) as GateResult[];
        expect(exported).toHaveLength(1);
        expect(exported[0]).toMatchObject({ phase: 'spec', decision: 'approved' });

        // The KV (the SOT) and the exported JSON agree byte-for-byte.
        const kv = store.getState<GateResult[]>('audit:task-1') ?? [];
        expect(exported).toEqual(kv);
      } finally {
        await store.close();
      }
    });

    it('throws for an unknown task (consistent with requireTask)', async () => {
      const store = await openStore({ projectId, root });
      try {
        const engine = new WorkflowEngine(store, root, projectId);
        await expect(engine.checkpoint('never-started')).rejects.toThrow(/Unknown task/);
      } finally {
        await store.close();
      }
    });
  });
});
