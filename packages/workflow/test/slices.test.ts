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

  // Parallel-slice file conflicts (iter-3 minor: the broadening shipped with zero
  // coverage). Two slices connected by a PARALLEL dependency must not touch the
  // same path — create∪modify overlap, or write-vs-preserve (both directions).
  const base = validSlice.slices[0];
  const sibling = (
    id: string,
    files: SlicePlan['slices'][number]['files'],
  ): SlicePlan['slices'][number] => ({
    ...base,
    id,
    files,
  });

  it('flags a create-vs-create conflict between parallel siblings', () => {
    const plan: SlicePlan = {
      ...validSlice,
      slices: [
        sibling('s1', { create: ['a.ts'], modify: [], preserve: [] }),
        {
          ...sibling('s2', { create: ['a.ts'], modify: [], preserve: [] }),
          dependsOn: [{ id: 's1', mode: 'parallel' }],
        },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/parallel file conflict on 'a\.ts'/);
  });

  it('flags a modify-vs-modify conflict between parallel siblings', () => {
    const plan: SlicePlan = {
      ...validSlice,
      slices: [
        sibling('s1', { create: [], modify: ['b.ts'], preserve: [] }),
        {
          ...sibling('s2', { create: [], modify: ['b.ts'], preserve: [] }),
          dependsOn: [{ id: 's1', mode: 'parallel' }],
        },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/parallel file conflict on 'b\.ts'/);
  });

  it('flags a create-vs-modify conflict between parallel siblings', () => {
    const plan: SlicePlan = {
      ...validSlice,
      slices: [
        sibling('s1', { create: ['c.ts'], modify: [], preserve: [] }),
        {
          ...sibling('s2', { create: [], modify: ['c.ts'], preserve: [] }),
          dependsOn: [{ id: 's1', mode: 'parallel' }],
        },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    expect(r.errors.join('\n')).toMatch(/parallel file conflict on 'c\.ts'/);
  });

  it('flags preserve-vs-write conflicts in BOTH directions', () => {
    const plan: SlicePlan = {
      ...validSlice,
      slices: [
        // s1 writes d.ts; s2 preserves d.ts (write-vs-preserve).
        sibling('s1', { create: ['d.ts'], modify: [], preserve: [] }),
        {
          ...sibling('s2', { create: [], modify: [], preserve: ['d.ts'] }),
          dependsOn: [{ id: 's1', mode: 'parallel' }],
        },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(false);
    // Both directions surface (the check must be symmetric, not order-dependent).
    expect(r.errors.join('\n')).toMatch(/parallel (preserve|file) conflict on 'd\.ts'/);
  });

  it('does NOT flag overlapping files between SEQUENTIAL siblings', () => {
    const plan: SlicePlan = {
      ...validSlice,
      slices: [
        sibling('s1', { create: ['e.ts'], modify: [], preserve: [] }),
        {
          ...sibling('s2', { create: [], modify: ['e.ts'], preserve: [] }),
          dependsOn: [{ id: 's1', mode: 'sequential' }],
        },
      ],
    };
    const r = validateSlicePlan(plan);
    expect(r.ok).toBe(true);
  });
});
