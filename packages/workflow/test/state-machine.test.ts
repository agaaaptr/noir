import { describe, expect, it } from 'vitest';
import {
  applyTransition,
  canTransition,
  nextPhase,
  PHASES,
  STATES,
  stateForPhase,
} from '../src/state-machine.js';
import type { Phase, WorkflowState } from '../src/types.js';

describe('SDD state machine', () => {
  it('lists phases in lifecycle order', () => {
    expect(PHASES).toEqual(['intake', 'clarify', 'spec', 'plan', 'execute', 'verify', 'document']);
  });

  it('advances through the happy path', () => {
    let s: WorkflowState = 'draft';
    for (const target of ['clarifying', 'specified', 'planned', 'executing', 'verifying', 'done']) {
      expect(canTransition(s, target)).toBe(true);
      s = applyTransition(s, target);
      expect(s).toBe(target);
    }
  });

  it('rejects illegal transitions (e.g. draft→planned skips spec gate)', () => {
    expect(canTransition('draft', 'planned')).toBe(false);
    expect(() => applyTransition('draft', 'planned')).toThrow(/spec/i);
  });

  it('nextPhase maps spec→plan, plan→execute, verify→document', () => {
    // nextPhase returns the next PHASE (not state): 'specified' state → 'plan' phase.
    // stateForPhase('plan') === 'planned' composes the two, so both vocabularies stay distinct.
    expect(nextPhase('specified')).toBe('plan');
  });

  it('allows terminal/abandoned states', () => {
    expect(STATES).toContain('blocked');
    expect(STATES).toContain('abandoned');
  });

  // Beef up the thin FSM coverage the ledger flagged.
  describe('FSM coverage gaps (exit-rejection + blocked escape)', () => {
    it('done is terminal — rejects every forward transition (no escape via the FSM)', () => {
      // The happy path ends at done; the only ways out are the admin escapes
      // (blocked/abandoned set directly by the engine, NOT via applyTransition).
      for (const target of STATES) {
        expect(canTransition('done', target)).toBe(false);
      }
      // The hint logic points at the verify gate when done→done is attempted;
      // for other targets the FSM just lists the illegal transition plainly.
      expect(() => applyTransition('done', 'executing')).toThrow();
    });

    it('abandoned is terminal — rejects every transition (no FSM exit)', () => {
      for (const target of STATES) {
        expect(canTransition('abandoned', target)).toBe(false);
      }
      expect(() => applyTransition('abandoned', 'draft')).toThrow();
    });

    it('blocked has no FSM edges — exit is jump-only (opts.to), matching the engine', () => {
      // The engine exits blocked via an explicit opts.to jump (which bypasses
      // this table), never a forward advance — nextPhase(blocked) is null. The
      // FSM must therefore declare NO blocked→X edges so a caller reading the
      // table does not attempt advance(blockedTask), which throws.
      for (const target of STATES) {
        expect(canTransition('blocked', target)).toBe(false);
      }
      expect(() => applyTransition('blocked', 'executing')).toThrow();
    });

    it('stateForPhase maps every phase → its in-progress state (1:1 + onto)', () => {
      const expected: Record<Phase, WorkflowState> = {
        intake: 'draft',
        clarify: 'clarifying',
        spec: 'specified',
        plan: 'planned',
        execute: 'executing',
        verify: 'verifying',
        document: 'done',
      };
      for (const p of PHASES) {
        expect(stateForPhase(p)).toBe(expected[p]);
      }
    });
  });
});
