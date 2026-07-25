import type { Store } from '@noir-ai/store';
import type { GateResult, GateResultInput, Phase, WorkflowState } from './types.js';

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
 * The audit lives at `audit:<taskId>` as a `GateResult[]` and is the
 * AUTHORITATIVE record for every gate outcome (S4 spec §5 / §11 OQ-5 — "audit
 * in store KV as source of truth + export to `.noir/audit/<taskId>.json`").
 * The {@link TaskState.history} field is a DERIVED view, regenerated from this
 * KV by the engine — never edited directly. This collapses the S4 dual source
 * of truth (debt-batch A / W1): one write, one timestamp, one read-back.
 *
 * This is the "quiet observable checkpoint": an `approved`, `forced`, or
 * `skipped` decision is always recorded — never silently dropped — and `forced`
 * carries a `reason`.
 *
 * `at` is stamped here (`Date.now()`) rather than trusted from the caller, so
 * the audit reflects when the gate actually fired (single timestamp — the W3
 * sub-ms drift between the engine's history stamp and the audit KV stamp is
 * gone, because there is no longer a second stamp). The write is append-only:
 * prior entries are read and preserved (never overwritten).
 */
export function recordGate(store: Store, taskId: string, result: GateResultInput): GateResult {
  const key = `audit:${taskId}`;
  const prior = store.getState<GateResult[]>(key) ?? [];
  const recorded: GateResult = { ...result, at: Date.now() };
  store.setState<GateResult[]>(key, [...prior, recorded]);
  return recorded;
}

/**
 * Read the authoritative gate audit for `taskId` from the store KV. Returns an
 * empty array when no gate has fired yet (a fresh task) — never `null`, so
 * callers can spread/index without a separate undefined check.
 *
 * The engine uses this to regenerate {@link TaskState.history} (the derived
 * view) on every advance and every status read; downstream consumers
 * (`buildWorkflowStatus`, the CLI `task status`) read `task.history` and so get
 * the derived-from-KV value indirectly — the audit KV remains the SOT they all
 * ultimately derive from.
 */
export function readGateHistory(store: Store, taskId: string): GateResult[] {
  return store.getState<GateResult[]>(`audit:${taskId}`) ?? [];
}
