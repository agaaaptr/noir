// c4-verify-gate-recovery — the evidence-backed verify gate. Pins:
//   • default OFF: no verify config ⇒ legacy approved/forced/skipped, no evidence, no blocking;
//   • required + no evidence ⇒ VerifyGateError(evidence-required), no transition, no audit entry;
//   • required + passing evidence ⇒ approved WITH evidence, transitions to done;
//   • required + failed HARD check ⇒ VerifyGateError(evidence-failed), a `failed` decision recorded WITH evidence, no transition;
//   • required + failed SOFT check ⇒ approved (soft-fail flagged), transitions;
//   • stale evidence (ranAt < updatedAt) ⇒ treated as no evidence;
//   • force/skip override the evaluation (the explicit escapes).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type GateEvidence,
  VerifyGateError,
  WorkflowEngine,
  type WorkflowGateConfig,
} from '../src/index.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-verify-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const verifyOn: WorkflowGateConfig = {
  prd: { mandatoryFor: ['feature', 'epic'] },
  verify: { required: { feature: true }, retryBudget: 2 },
};

/** Walk a task from intake to verifying (one step short of the verify gate). */
async function toVerifying(engine: WorkflowEngine, id: string): Promise<void> {
  await engine.startTask(id, 'task-x', 'full', 'feature');
  await engine.advance(id); // draft → clarifying
  await engine.advance(id); // → specified (spec gate)
  await engine.advance(id); // → planned (plan gate)
  await engine.advance(id); // → executing
  await engine.advance(id); // → verifying
}

const passEvidence = (): GateEvidence => ({
  ranAt: Date.now(),
  summary: '2 passed, 0 failed',
  checks: [
    { name: 'test', exitCode: 0, outputDigest: 'a'.repeat(64), command: 'pnpm test' },
    { name: 'lint', exitCode: 0, outputDigest: 'b'.repeat(64), command: 'pnpm lint' },
  ],
});

const failHardEvidence = (): GateEvidence => ({
  ranAt: Date.now(),
  summary: '1 passed, 1 failed',
  checks: [
    { name: 'test', exitCode: 1, outputDigest: 'a'.repeat(64), command: 'pnpm test', tier: 'hard' },
    { name: 'lint', exitCode: 0, outputDigest: 'b'.repeat(64), command: 'pnpm lint', tier: 'hard' },
  ],
});

const failSoftEvidence = (): GateEvidence => ({
  ranAt: Date.now(),
  summary: '1 passed, 1 soft-failed',
  checks: [
    { name: 'docs', exitCode: 1, outputDigest: 'a'.repeat(64), command: 'pnpm docs', tier: 'soft' },
    { name: 'lint', exitCode: 0, outputDigest: 'b'.repeat(64), command: 'pnpm lint', tier: 'hard' },
  ],
});

describe('verify gate — default OFF (backward compatible)', () => {
  it('no verify config ⇒ legacy approved, no evidence, no blocking', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p'); // default gateConfig
      await toVerifying(engine, 't1');
      // No evidence supplied — legacy path transitions and records approved.
      const res = await engine.advance('t1');
      expect(res.state).toBe('done');
      const verifyGate = res.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('approved');
      expect(verifyGate?.evidence).toBeUndefined();
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — evidence-required', () => {
  it('required + no evidence ⇒ throws evidence-required, no transition, no audit entry', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't2');
      const before = engine.status('t2');
      await expect(engine.advance('t2')).rejects.toBeInstanceOf(VerifyGateError);
      // State unchanged.
      const after = engine.status('t2');
      expect(after?.state).toBe('verifying');
      expect(after?.state).toBe(before?.state);
      // No verify gate was recorded (pending = absence of decision).
      const verifyGate = after?.history.find((g) => g.phase === 'verify');
      expect(verifyGate).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('empty checks ⇒ throws evidence-required (faux evidence is rejected), no transition', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't2-empty');
      const fakeEmpty = { ranAt: Date.now(), summary: '0 checks', checks: [] };
      try {
        await engine.advance('t2-empty', { evidence: fakeEmpty });
        expect.fail('should have thrown evidence-required');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyGateError);
        expect((err as VerifyGateError).kind).toBe('evidence-required');
      }
      // No transition, no gate recorded.
      const after = engine.status('t2-empty');
      expect(after?.state).toBe('verifying');
      expect(after?.history.find((g) => g.phase === 'verify')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('evidence on an advance that does NOT cross the verify gate is rejected (fail-fast)', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await engine.startTask('t-ev', 'task-x', 'full', 'feature');
      for (let i = 0; i < 4; i++) await engine.advance('t-ev'); // → executing
      expect(engine.status('t-ev')?.state).toBe('executing');
      // Advance from executing lands on verifying (NOT the verify gate), so
      // supplying evidence must fail fast — never silently discard the checks
      // and let a caller report a false "gate approved".
      await expect(engine.advance('t-ev', { evidence: passEvidence() })).rejects.toMatchObject({
        kind: 'off-gate',
      });
      expect(engine.status('t-ev')?.state).toBe('executing');
      expect(engine.status('t-ev')?.history.find((g) => g.phase === 'verify')).toBeUndefined();
    } finally {
      await store.close();
    }
  });

  it('stale evidence (ranAt < updatedAt) ⇒ treated as no evidence', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't3');
      const stale: GateEvidence = { ...passEvidence(), ranAt: 0 };
      await expect(engine.advance('t3', { evidence: stale })).rejects.toBeInstanceOf(
        VerifyGateError,
      );
      expect(engine.status('t3')?.state).toBe('verifying');
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — passing evidence', () => {
  it('required + all HARD green ⇒ approved WITH evidence, transitions to done', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't4');
      const res = await engine.advance('t4', { evidence: passEvidence() });
      expect(res.state).toBe('done');
      const verifyGate = res.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('approved');
      expect(verifyGate?.evidence?.summary).toBe('2 passed, 0 failed');
    } finally {
      await store.close();
    }
  });

  it('required + failed SOFT check ⇒ approved (soft-fail flagged), transitions', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't5');
      const res = await engine.advance('t5', { evidence: failSoftEvidence() });
      expect(res.state).toBe('done');
      const verifyGate = res.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('approved');
      expect(verifyGate?.evidence?.summary).toContain('soft-failed');
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — deep-merged partial config', () => {
  it('a PARTIAL verify config (no retryBudget) still defaults retryBudget to 2', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      // Only `required` is set — the constructor must deep-merge the default
      // retryBudget (a shallow merge would leave it undefined and make the
      // budget check misfire on the FIRST failure).
      const partial: WorkflowGateConfig = {
        prd: { mandatoryFor: ['feature', 'epic'] },
        verify: { required: { feature: true } } as never,
      } as never;
      const engine = new WorkflowEngine(store, root, 'p', partial);
      await toVerifying(engine, 't-partial');
      // First hard-fail must be evidence-failed (not budget-exhausted) — proving
      // the default retryBudget (2) survived the deep-merge.
      try {
        await engine.advance('t-partial', { evidence: failHardEvidence() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyGateError);
        expect((err as VerifyGateError).kind).toBe('evidence-failed');
      }
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — evidence-failed', () => {
  it('required + failed HARD ⇒ throws evidence-failed, `failed` recorded WITH evidence, no transition', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't6');
      try {
        await engine.advance('t6', { evidence: failHardEvidence() });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyGateError);
        const e = err as VerifyGateError;
        expect(e.kind).toBe('evidence-failed');
        expect(e.evidence?.summary).toContain('failed');
      }
      // No transition.
      expect(engine.status('t6')?.state).toBe('verifying');
      // BUT the `failed` decision WAS recorded (observable failure).
      const after = engine.status('t6');
      const verifyGate = after?.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('failed');
      expect(verifyGate?.evidence).toBeDefined();
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — retry budget exhaustion', () => {
  it('retryBudget (2) trips on the third consecutive hard-fail: budget-exhausted, no extra `failed` entry, no transition', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't9');
      // Fresh evidence PER attempt (ranAt must be >= task.updatedAt — each
      // advance bumps it, so a single captured ranAt goes stale).
      const attempt = (): GateEvidence => ({
        ranAt: Date.now(),
        summary: '0 passed, 1 failed',
        checks: [
          {
            name: 'test',
            exitCode: 1,
            outputDigest: 'a'.repeat(64),
            command: 'pnpm test',
            tier: 'hard',
          },
        ],
      });
      // Attempts 1 + 2: `failed` recorded each time, budget not yet exhausted.
      for (let i = 0; i < 2; i++) {
        try {
          await engine.advance('t9', { evidence: attempt() });
          expect.fail(`attempt ${i + 1} should have thrown`);
        } catch (err) {
          expect(err).toBeInstanceOf(VerifyGateError);
          expect((err as VerifyGateError).kind).toBe('evidence-failed');
        }
      }
      // Attempt 3: prior failures (2) >= retryBudget (2) ⇒ budget-exhausted.
      try {
        await engine.advance('t9', { evidence: attempt() });
        expect.fail('third attempt should have thrown budget-exhausted');
      } catch (err) {
        expect(err).toBeInstanceOf(VerifyGateError);
        const e = err as VerifyGateError;
        expect(e.kind).toBe('budget-exhausted');
        expect(e.evidence?.summary).toContain('failed');
      }
      // Exactly 2 `failed` entries — the budget-exhausted attempt records none.
      const after = engine.status('t9');
      const failedEntries = after?.history.filter(
        (g) => g.phase === 'verify' && g.decision === 'failed',
      );
      expect(failedEntries?.length).toBe(2);
      // State unchanged — the task never advanced past verifying.
      expect(engine.status('t9')?.state).toBe('verifying');
    } finally {
      await store.close();
    }
  });
});

describe('verify gate — force/skip override', () => {
  it('required + force ⇒ forced (override), transitions even without evidence', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't7');
      const res = await engine.advance('t7', { force: { reason: 'known-good override' } });
      expect(res.state).toBe('done');
      const verifyGate = res.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('forced');
      expect(verifyGate?.reason).toBe('known-good override');
    } finally {
      await store.close();
    }
  });

  it('required + skip ⇒ skipped (override), transitions', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p', verifyOn);
      await toVerifying(engine, 't8');
      const res = await engine.advance('t8', { skip: true });
      expect(res.state).toBe('done');
      const verifyGate = res.history.find((g) => g.phase === 'verify');
      expect(verifyGate?.decision).toBe('skipped');
    } finally {
      await store.close();
    }
  });
});

// c4-research-grounding — recordResearch / readResearch / setOpenQuestions

describe('recordResearch / readResearch', () => {
  it('appends a research entry and readResearch returns it', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r1', 'task-r', 'full', 'feature');
      const entry = engine.recordResearch('r1', {
        type: 'discovery',
        text: 'API gateway requires X-Api-Key header',
        source: 'docs/api.md:42',
      });
      expect(entry.type).toBe('discovery');
      expect(typeof entry.at).toBe('number');
      expect(engine.readResearch('r1')).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('readResearch returns empty array for a task with no findings', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r2', 'task-s', 'full');
      expect(engine.readResearch('r2')).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it('rejects empty text', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r3', 'task-t', 'full');
      expect(() => engine.recordResearch('r3', { type: 'discovery', text: '   ' })).toThrow(
        'non-empty',
      );
    } finally {
      await store.close();
    }
  });

  it('rejects text exceeding the cap', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r4', 'task-u', 'full');
      expect(() =>
        engine.recordResearch('r4', { type: 'discovery', text: 'x'.repeat(221) }),
      ).toThrow('exceeds');
    } finally {
      await store.close();
    }
  });

  it('rejects non-grounding-fact without a source (requireSource on)', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r5', 'task-v', 'full');
      expect(() =>
        engine.recordResearch('r5', { type: 'discovery', text: 'some finding' }),
      ).toThrow('requires a source');
    } finally {
      await store.close();
    }
  });

  it('allows grounding-fact without a source', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('r6', 'task-w', 'full');
      const entry = engine.recordResearch('r6', {
        type: 'grounding-fact',
        text: 'project uses TypeScript 5.x',
      });
      expect(entry.type).toBe('grounding-fact');
    } finally {
      await store.close();
    }
  });
});

describe('setOpenQuestions + clarify gating', () => {
  it('setOpenQuestions filters empty/whitespace', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('q1', 'task-q', 'full');
      engine.setOpenQuestions('q1', ['', '  ', 'valid']);
      expect(engine.status('q1')?.openQuestions).toEqual(['valid']);
    } finally {
      await store.close();
    }
  });

  it('clarify→spec blocked when openQuestions non-empty', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('q2', 'task-r2', 'full');
      await engine.advance('q2');
      engine.setOpenQuestions('q2', ['unresolved']);
      await expect(engine.advance('q2')).rejects.toThrow('open question(s) unresolved');
      expect(engine.status('q2')?.state).toBe('clarifying');
    } finally {
      await store.close();
    }
  });

  it('--force overrides the open-questions gate', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('q3', 'task-r3', 'full');
      await engine.advance('q3');
      engine.setOpenQuestions('q3', ['unresolved']);
      const res = await engine.advance('q3', { force: { reason: 'resolved offline' } });
      expect(res.state).toBe('specified');
      expect(res.history.find((g) => g.phase === 'spec')?.decision).toBe('forced');
    } finally {
      await store.close();
    }
  });

  it('--skip overrides the open-questions gate', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('q4', 'task-r4', 'full');
      await engine.advance('q4');
      engine.setOpenQuestions('q4', ['unresolved']);
      const res = await engine.advance('q4', { skip: true });
      expect(res.state).toBe('specified');
    } finally {
      await store.close();
    }
  });

  it('jump bypasses open-questions gate', async () => {
    const store = await openStore({ projectId: 'p', root });
    try {
      const engine = new WorkflowEngine(store, root, 'p');
      await engine.startTask('q5', 'task-r5', 'full');
      await engine.advance('q5');
      engine.setOpenQuestions('q5', ['unresolved']);
      const res = await engine.advance('q5', { to: 'execute' });
      expect(res.state).toBe('executing');
    } finally {
      await store.close();
    }
  });
});
