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

/** Coerce a possibly-malformed array field to an iterable (schema errors were
 *  already pushed above; the downstream passes must never crash on them). */
function arr<T>(x: T[] | undefined | null): T[] {
  return Array.isArray(x) ? x : [];
}

/** Deps coerced + filtered to OBJECT elements (a string/number element has no
 *  `id`/`mode` and must not be dereferenced). */
function depsOf(s: { dependsOn: unknown }): { id: string; mode: string }[] {
  return arr(s.dependsOn as { id: string; mode: string }[]).filter(
    (d): d is { id: string; mode: string } => d !== null && typeof d === 'object',
  );
}

/** Validate a SlicePlan deterministically — schema, deps, file conflicts. */
export function validateSlicePlan(plan: SlicePlan): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  // Top-level guard: a malformed plan that omits `slices` must be a schema
  // error, not a crash on `for (const s of plan.slices)`.
  if (!Array.isArray(plan.slices)) return { ok: false, errors: ['slices must be an array'] };
  const ids = new Set<string>();

  for (const s of plan.slices) {
    // Duplicate IDs.
    if (ids.has(s.id)) errors.push(`duplicate slice id: ${s.id}`);
    ids.add(s.id);

    // Required fields. This is a runtime validator over LLM/opt-in content, so
    // array fields are checked with Array.isArray — a malformed slice that omits
    // them must produce a schema error, not a crash.
    if (!s.id) errors.push(`slice ${ids.size}: missing id`);
    if (!s.title) errors.push(`slice ${s.id}: missing title`);
    if (!s.rationale) errors.push(`slice ${s.id}: missing rationale`);
    if (!Array.isArray(s.acceptance) || s.acceptance.length === 0)
      errors.push(`slice ${s.id}: missing acceptance criteria`);
    if (!Array.isArray(s.doD) || s.doD.length === 0) errors.push(`slice ${s.id}: missing doD`);
    if (!s.rollbackPlan?.procedure) errors.push(`slice ${s.id}: missing rollbackPlan.procedure`);
    if (!Array.isArray(s.dependsOn)) errors.push(`slice ${s.id}: dependsOn must be an array`);
    if (!Array.isArray(s.files?.create) || !Array.isArray(s.files?.modify))
      errors.push(`slice ${s.id}: files.create/modify must be arrays`);
  }

  // Dependency validation: self-refs + missing refs (cheap, deterministic), then
  // a real DFS cycle check (A→B→A or any longer loop) over the dep graph.
  for (const s of plan.slices) {
    for (const dep of depsOf(s)) {
      if (dep.id === s.id) errors.push(`slice ${s.id}: self-referencing dependency`);
      if (!ids.has(dep.id)) errors.push(`slice ${s.id}: depends on unknown slice ${dep.id}`);
    }
  }

  // DFS cycle detection (three-color). Any back-edge to a gray (in-progress)
  // node is a cycle. Deterministic + no graph dependency.
  const deps = new Map<string, string[]>();
  for (const s of plan.slices)
    deps.set(
      s.id,
      depsOf(s)
        .map((d) => d.id)
        .filter((id) => ids.has(id)),
    );
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>(plan.slices.map((s) => [s.id, WHITE]));
  const stack: string[] = [];
  const visit = (id: string): void => {
    color.set(id, GRAY);
    stack.push(id);
    for (const next of deps.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) {
        // Found a cycle: report the back-edge slice + the cycle path.
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next].join(' → ');
        errors.push(`dependency cycle: ${cycle}`);
      } else if (c === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };
  for (const s of plan.slices) if (color.get(s.id) === WHITE) visit(s.id);

  // File conflicts between parallel siblings: ANY overlap in a slice's written
  // paths (create ∪ modify, and create-vs-preserve) between two parallel
  // siblings is a real merge conflict. Previously only create-vs-create was
  // flagged, so two siblings that BOTH modify the same file (or one creates and
  // one modifies the same path) slipped past validation.
  for (const s of plan.slices) {
    const parallelDeps = depsOf(s).filter((d) => d.mode === 'parallel');
    for (const pd of parallelDeps) {
      const sibling = plan.slices.find((x) => x.id === pd.id);
      if (!sibling) continue;
      // Malformed file arrays were already flagged above; coerce to [] so a
      // null/absent files field cannot crash the conflict pass.
      const sFiles = arr(s.files?.create).concat(arr(s.files?.modify));
      const siblingFiles = arr(sibling.files?.create).concat(arr(sibling.files?.modify));
      const sPreserve = arr(s.files?.preserve);
      const siblingPreserve = arr(sibling.files?.preserve);
      // What this slice WRITES (creates + modifies) — its own footprint.
      const sWrites = new Set(sFiles);
      // What the sibling writes (creates + modifies) AND preserves (a sibling
      // preserving a path we also create/modify is equally a conflict).
      for (const f of siblingFiles) {
        if (sWrites.has(f))
          errors.push(`slice ${s.id}: parallel file conflict on '${f}' with sibling ${pd.id}`);
      }
      for (const f of siblingPreserve) {
        if (sWrites.has(f))
          errors.push(
            `slice ${s.id}: parallel preserve conflict on '${f}' with sibling ${pd.id} (preserve vs write)`,
          );
      }
      // Reverse direction: this slice PRESERVES a path the sibling writes
      // (a symmetric pair — the check must not depend on slice ordering).
      const siblingWrites = new Set(siblingFiles);
      for (const f of sPreserve) {
        if (siblingWrites.has(f))
          errors.push(
            `slice ${s.id}: parallel preserve conflict on '${f}' with sibling ${pd.id} (write vs preserve)`,
          );
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
