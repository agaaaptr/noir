import type { Store } from '@noir-ai/store';
import type { GateResult, Phase, WorkflowState } from './types.js';

/**
 * The workflow state a phase's gate guards entry into (Noir §9.1 observable
 * checkpoint). A gate fires when its phase completes:
 *   spec-gate   → entering `specified`
 *   plan-gate   → entering `planned`
 *   verify-gate → entering `done`
 *
 * Phases without a gate (intake / clarify / execute / document) return `null`.
 * This is distinct from {@link stateForPhase}: `stateForPhase('verify')` is the
 * in-progress `verifying`, while `gateFor('verify')` is the state the verify
 * gate admits you into (`done`).
 */
export function gateFor(phase: Phase): WorkflowState | null {
  switch (phase) {
    case 'spec':
      return 'specified';
    case 'plan':
      return 'planned';
    case 'verify':
      return 'done';
    default:
      return null;
  }
}

/**
 * Append a gate decision to the task's audit log in the store KV.
 *
 * The audit lives at `audit:<taskId>` as a `GateResult[]` and is the source of
 * truth for every gate outcome (the `.noir/audit/` export is a later helper).
 * This is the "quiet observable checkpoint": an `approved`, `forced`, or
 * `skipped` decision is always recorded — never silently dropped — and `forced`
 * carries a `reason`.
 *
 * `at` is stamped here (`Date.now()`) rather than trusted from the caller, so
 * the audit reflects when the gate actually fired. The write is append-only:
 * prior entries are read and preserved (never overwritten).
 */
export function recordGate(store: Store, taskId: string, result: GateResult): void {
  const key = `audit:${taskId}`;
  const prior = store.getState<GateResult[]>(key) ?? [];
  store.setState<GateResult[]>(key, [...prior, { ...result, at: Date.now() }]);
}
