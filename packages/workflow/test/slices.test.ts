// c4-decomposition — validateSlicePlan deterministic validation.
import { describe, expect, it } from 'vitest';
import { type SlicePlan, validateSlicePlan } from '../src/index.js';

const validSlice: SlicePlan = {
  capabilityId: 'C4',
  intent: 'Test capability',
  slices: [
    {
      id: 's1',
      title: 'Walking skeleton',
      type: 'feature',
      rationale: 'First slice.',
      scopeIn: 'Core path.',
      scopeOut: 'Polish.',
      dependsOn: [],
      files: { create: [], modify: [], preserve: [] },
      acceptance: ['pnpm test'],
      doD: ['pnpm test', 'pnpm typecheck'],
      rollbackPlan: { procedure: 'revert commit', verifyCommand: 'pnpm test' },
    },
  ],
  status: { s1: 'planned' },
};

describe('validateSlicePlan', () => {
  it('valid plan passes', () => {
    expect(validateSlicePlan(validSlice)).toMatchObject({ ok: true, errors: [] });
  });

  it('rejects duplicate slice ids', () => {
    const plan = { ...validSlice, slices: [validSlice.slices[0], validSlice.slices[0]] };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('duplicate slice id: s1');
  });

  it('rejects missing id', () => {
    const plan = { ...validSlice, slices: [{ ...validSlice.slices[0], id: '' }] };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects missing title', () => {
    const plan = { ...validSlice, slices: [{ ...validSlice.slices[0], title: '' }] };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects missing rationale', () => {
    const plan = { ...validSlice, slices: [{ ...validSlice.slices[0], rationale: '' }] };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects missing acceptance criteria', () => {
    const plan = { ...validSlice, slices: [{ ...validSlice.slices[0], acceptance: [] }] };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects missing doD', () => {
    const plan = { ...validSlice, slices: [{ ...validSlice.slices[0], doD: [] }] };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects missing rollbackPlan.procedure', () => {
    const plan = {
      ...validSlice,
      slices: [{ ...validSlice.slices[0], rollbackPlan: { procedure: '' } }],
    };
    expect(validateSlicePlan(plan).ok).toBe(false);
  });

  it('rejects self-referencing dependency', () => {
    const plan = {
      ...validSlice,
      slices: [{ ...validSlice.slices[0], dependsOn: [{ id: 's1', mode: 'sequential' as const }] }],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('slice s1: self-referencing dependency');
  });

  it('rejects dependency on unknown slice', () => {
    const plan = {
      ...validSlice,
      slices: [
        { ...validSlice.slices[0], dependsOn: [{ id: 's-unknown', mode: 'sequential' as const }] },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('slice s1: depends on unknown slice s-unknown');
  });
});
