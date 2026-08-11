// c4-decomposition — SlicePlan + Slice types and deterministic validation.
// The capability→slice roadmap pass lives ABOVE the spec FSM (each slice then
// re-enters the existing clarify→spec→plan lifecycle). Fixed schema + optional
// LLM content + deterministic validation (schema, dependency-cycle detection).

export type SliceType = 'feature' | 'tech' | 'spike';

export interface Slice {
  id: string; // stable, greppable, e.g. "s1-walking-skeleton"
  title: string;
  type: SliceType;
  /** 1-3 sentences — drift is flaggable against this. */
  rationale: string;
  /** What this slice delivers. */
  scopeIn: string;
  /** Explicitly deferred to sibling slices (boundary). */
  scopeOut: string;
  dependsOn: { id: string; mode: 'sequential' | 'parallel' }[];
  files: { create: string[]; modify: string[]; preserve: string[] };
  /** Concrete commands/assertions (deterministic). */
  acceptance: string[];
  /** build/test/typecheck commands. */
  doD: string[];
  rollbackPlan: {
    /** Operator-executable halt/revert procedure. */
    procedure: string;
    /** How to confirm the revert worked. */
    verifyCommand?: string;
  };
}

export interface SlicePlan {
  capabilityId: string;
  /** One-line capability intent (Spec-of-Specs "Intent"). */
  intent: string;
  slices: Slice[];
  status: Record<string, 'planned' | 'in-progress' | 'done'>;
}

/** Validate a SlicePlan deterministically — schema, deps, file conflicts. */
export function validateSlicePlan(plan: SlicePlan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const s of plan.slices) {
    // Duplicate IDs.
    if (ids.has(s.id)) errors.push(`duplicate slice id: ${s.id}`);
    ids.add(s.id);

    // Required fields.
    if (!s.id) errors.push(`slice ${ids.size}: missing id`);
    if (!s.title) errors.push(`slice ${s.id}: missing title`);
    if (!s.rationale) errors.push(`slice ${s.id}: missing rationale`);
    if (s.acceptance.length === 0) errors.push(`slice ${s.id}: missing acceptance criteria`);
    if (s.doD.length === 0) errors.push(`slice ${s.id}: missing doD`);
    if (!s.rollbackPlan?.procedure) errors.push(`slice ${s.id}: missing rollbackPlan.procedure`);
  }

  // Dependency-cycle detection — simple topological check on the dep graph.
  // (Not a full cycle-detection algorithm; rejects only trivial self-refs
  // and missing refs — enough for deterministic validation without a graph lib.)
  for (const s of plan.slices) {
    for (const dep of s.dependsOn) {
      if (dep.id === s.id) errors.push(`slice ${s.id}: self-referencing dependency`);
      if (!ids.has(dep.id)) errors.push(`slice ${s.id}: depends on unknown slice ${dep.id}`);
    }
  }

  // File conflicts between parallel siblings.
  for (const s of plan.slices) {
    const parallelDeps = s.dependsOn.filter((d) => d.mode === 'parallel');
    for (const pd of parallelDeps) {
      const sibling = plan.slices.find((x) => x.id === pd.id);
      if (!sibling) continue;
      const sCreates = new Set(s.files.create);
      for (const f of sibling.files.create) {
        if (sCreates.has(f))
          errors.push(`slice ${s.id}: parallel file conflict on '${f}' with sibling ${pd.id}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
