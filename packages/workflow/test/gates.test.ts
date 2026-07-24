import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectId } from '@noir-ai/core';
import { openStore } from '@noir-ai/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gateFor, recordGate } from '../src/gates.js';
import type { GateResult } from '../src/types.js';

// Real-store setup mirroring @noir-ai/store's own tests: a fresh temp-dir DB
// per test, so audit KV assertions hit the actual SQLite path (not a mock).
let root: string;
let id: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'noir-workflow-gates-'));
  id = createProjectId();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('observable gates + audit recording', () => {
  it('records approved/forced/skipped decisions to audit:<taskId> in order', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      const t0 = Date.now();
      // approved — happy path through the spec gate
      recordGate(store, 'task-1', { phase: 'spec', decision: 'approved', at: 0 });
      // forced — carries a reason (e.g. user override of the plan gate)
      recordGate(store, 'task-1', {
        phase: 'plan',
        decision: 'forced',
        reason: 'user overrode plan gate',
        at: 0,
      });
      // skipped — quick mode bypasses the verify gate
      recordGate(store, 'task-1', { phase: 'verify', decision: 'skipped', at: 0 });

      const audit = store.getState<GateResult[]>('audit:task-1');
      expect(audit).not.toBeNull();
      expect(audit).toHaveLength(3);

      // entry 0 — approved (no reason key)
      expect(audit?.[0]).toEqual({
        phase: 'spec',
        decision: 'approved',
        at: expect.any(Number),
      });
      // at is stamped by recordGate (caller passed 0), and is recent
      expect(audit?.[0]?.at).toBeGreaterThanOrEqual(t0);

      // entry 1 — forced, carries the reason
      expect(audit?.[1]).toEqual({
        phase: 'plan',
        decision: 'forced',
        reason: 'user overrode plan gate',
        at: expect.any(Number),
      });

      // entry 2 — skipped (quick mode)
      expect(audit?.[2]).toEqual({
        phase: 'verify',
        decision: 'skipped',
        at: expect.any(Number),
      });

      // entries are ordered as written (append-only, non-decreasing at)
      expect(audit?.[1]?.at).toBeGreaterThanOrEqual(audit?.[0]?.at ?? 0);
      expect(audit?.[2]?.at).toBeGreaterThanOrEqual(audit?.[1]?.at ?? 0);
    } finally {
      await store.close();
    }
  });

  it('is append-only — prior entries survive a later record (no overwrite)', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      recordGate(store, 'task-2', { phase: 'spec', decision: 'approved', at: 0 });
      expect(store.getState<GateResult[]>('audit:task-2')).toHaveLength(1);

      recordGate(store, 'task-2', { phase: 'plan', decision: 'approved', at: 0 });
      const after2 = store.getState<GateResult[]>('audit:task-2');
      expect(after2).toHaveLength(2);
      // the first entry is intact (not overwritten by the second write)
      expect(after2?.[0]).toMatchObject({ phase: 'spec', decision: 'approved' });
      expect(after2?.[1]).toMatchObject({ phase: 'plan', decision: 'approved' });
    } finally {
      await store.close();
    }
  });

  it('starts from an empty array when no prior audit exists', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      expect(store.getState<GateResult[]>('audit:task-3')).toBeNull();
      recordGate(store, 'task-3', { phase: 'spec', decision: 'approved', at: 0 });
      expect(store.getState<GateResult[]>('audit:task-3')).toHaveLength(1);
    } finally {
      await store.close();
    }
  });

  it('keeps per-task audit logs isolated by taskId', async () => {
    const store = await openStore({ projectId: id, root });
    try {
      recordGate(store, 'task-a', { phase: 'spec', decision: 'approved', at: 0 });
      recordGate(store, 'task-b', { phase: 'plan', decision: 'forced', reason: 'x', at: 0 });
      expect(store.getState<GateResult[]>('audit:task-a')).toHaveLength(1);
      expect(store.getState<GateResult[]>('audit:task-b')).toHaveLength(1);
      expect(store.getState<GateResult[]>('audit:task-a')?.[0]?.decision).toBe('approved');
    } finally {
      await store.close();
    }
  });

  it('gateFor maps spec→specified, plan→planned, verify→done; null elsewhere', () => {
    expect(gateFor('spec')).toBe('specified');
    expect(gateFor('plan')).toBe('planned');
    expect(gateFor('verify')).toBe('done');
    expect(gateFor('intake')).toBeNull();
    expect(gateFor('clarify')).toBeNull();
    expect(gateFor('execute')).toBeNull();
    expect(gateFor('document')).toBeNull();
  });
});
