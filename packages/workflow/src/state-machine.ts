import type { Phase, WorkflowState } from './types.js';

// Re-export the phase/state vocabularies so consumers can import the entire FSM
// surface from one module (the test imports PHASES/STATES from here).
export { PHASES, STATES } from './types.js';

// Legal state transitions (happy path + terminal). Gates (spec/plan/verify) are
// modeled as the transition INTO specified/planned/done — the engine records a
// GateResult at that point (see gates.ts).
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  draft: ['clarifying'],
  clarifying: ['specified'],
  specified: ['planned'],
  planned: ['executing'],
  executing: ['verifying'],
  verifying: ['done'],
  done: [],
  // `blocked` has NO outgoing edges: the engine exits blocked only via an
  // explicit `opts.to` jump (which bypasses this table), NOT a forward advance
  // (nextPhase(blocked) is null). Declaring edges here would mislead a caller
  // into calling advance(blockedTask) — which throws.
  blocked: [],
  abandoned: [],
};

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function applyTransition(from: WorkflowState, to: WorkflowState): WorkflowState {
  if (!canTransition(from, to)) {
    const hint =
      to === 'planned'
        ? ' (the spec gate must be passed first)'
        : to === 'executing'
          ? ' (the plan gate must be passed first)'
          : to === 'done'
            ? ' (the verify gate must be passed first)'
            : '';
    throw new Error(`Illegal transition ${from} → ${to}${hint}`);
  }
  return to;
}

// Phase <-> state mapping for the engine.
export function stateForPhase(p: Phase): WorkflowState {
  switch (p) {
    case 'intake':
      return 'draft';
    case 'clarify':
      return 'clarifying';
    case 'spec':
      return 'specified';
    case 'plan':
      return 'planned';
    case 'execute':
      return 'executing';
    case 'verify':
      return 'verifying';
    case 'document':
      return 'done';
  }
}

export function nextPhase(state: WorkflowState): Phase | null {
  const map: Partial<Record<WorkflowState, Phase>> = {
    draft: 'clarify',
    clarifying: 'spec',
    specified: 'plan',
    planned: 'execute',
    executing: 'verify',
    verifying: 'document',
  };
  return map[state] ?? null;
}
