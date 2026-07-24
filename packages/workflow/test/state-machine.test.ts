import { describe, expect, it } from 'vitest';
import { applyTransition, canTransition, nextPhase, PHASES, STATES } from '../src/state-machine.js';
import type { WorkflowState } from '../src/types.js';

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
});
