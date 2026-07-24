import type { ProjectId } from '@noir-ai/core';

export const PHASES = [
  'intake',
  'clarify',
  'spec',
  'plan',
  'execute',
  'verify',
  'document',
] as const;
export type Phase = (typeof PHASES)[number];

export const STATES = [
  'draft',
  'clarifying',
  'specified',
  'planned',
  'executing',
  'verifying',
  'done',
  'blocked',
  'abandoned',
] as const;
export type WorkflowState = (typeof STATES)[number];

export type Mode = 'full' | 'quick';

export interface GateResult {
  phase: Phase;
  decision: 'approved' | 'forced' | 'skipped';
  reason?: string;
  at: number;
}

export interface TaskState {
  taskId: string;
  slug: string;
  projectId: ProjectId;
  state: WorkflowState;
  phase: Phase;
  mode: Mode;
  history: GateResult[]; // gate decisions (audit in-process view)
  jumpEntry?: Phase; // recorded if a jump-to-phase happened
  /** Reason captured by `setBlocked` (admin escape; set directly, not via FSM). */
  blockReason?: string;
  updatedAt: number;
}
