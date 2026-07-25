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

/**
 * Task classification — drives the soft, escapable gate predicates (slice P:
 * the PRD recommendation at the spec gate). Mirrors the user-facing
 * `prd.mandatoryFor` enum in @noir-ai/core's `NoirConfigSchema` (declared
 * LOCALLY here so workflow has no core-cycle concern; the two literals stay in
 * sync by tests). `undefined` (the default for legacy tasks) ⇒ no soft gate
 * fires — additive, fully backward-compatible.
 */
export const TASK_CLASSES = [
  'feature',
  'epic',
  'enhancement',
  'bugfix',
  'spike',
  'quick-task',
  'refactor',
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

/**
 * Input shape for {@link recordGate} — what CALLERS pass. Omits `at` (the
 * recorder stamps it from `Date.now()` so the audit reflects when the gate
 * actually fired, not when the caller constructed the object). Split out of
 * {@link GateResult} (debt-batch A / W3): callers used to pass a throwaway
 * `at: 0` that recordGate overrode — this shape makes the override implicit.
 */
export interface GateResultInput {
  phase: Phase;
  decision: 'approved' | 'forced' | 'skipped';
  reason?: string;
}

/**
 * A recorded gate decision — the AUTHORITATIVE shape stored in the
 * `audit:<taskId>` KV (the SOT per S4 spec §5 / §11 OQ-5) and surfaced via
 * `task.history` (a derived view the engine regenerates from the audit KV).
 * `at` is always present here; callers that want to RECORD a gate pass
 * {@link GateResultInput} (no `at`) to {@link recordGate}.
 */
export interface GateResult extends GateResultInput {
  at: number;
}

export interface TaskState {
  taskId: string;
  slug: string;
  projectId: ProjectId;
  state: WorkflowState;
  phase: Phase;
  mode: Mode;
  /**
   * DERIVED view of the gate audit for this task, regenerated from the
   * authoritative `audit:<taskId>` KV (S4 spec §11 OQ-5) by the engine on
   * every write and every status read. Kept on the TaskState so consumers
   * (CLI `task status`, the daemon `workflow_status` tool, MCP clients) can
   * read the gate history from the persisted TaskState without a second KV
   * lookup. Never edited directly outside the engine — derive via
   * {@link readGateHistory}.
   */
  history: GateResult[];
  /** Task classification (slice P). `undefined` ⇒ no soft PRD gate fires. */
  taskClass?: TaskClass;
  jumpEntry?: Phase; // recorded if a jump-to-phase happened
  /** Reason captured by `setBlocked` (admin escape; set directly, not via FSM). */
  blockReason?: string;
  updatedAt: number;
}

/**
 * The gate-config slice the engine consumes (debt-batch A / P4). Mirrors the
 * user-facing `prd:` block from @noir-ai/core's `NoirConfigSchema` — declared
 * locally (with a `readonly` array) so workflow has no core-cycle concern; the
 * daemon / CLI bridges NoirConfig → this shape at construction time. Every
 * field has a sane default, so an unspecified `gateConfig` (the legacy
 * constructor call) resolves to "feature/epic trigger the PRD recommendation".
 */
export interface WorkflowGateConfig {
  /**
   * PRD soft-gate config. `mandatoryFor` lists the task classes for which a
   * missing PRD artifact (at the moment of entering the spec phase, in full
   * mode) is surfaced as an observable, escapable recommendation on the spec
   * gate. The advance still proceeds — `--force <reason>` is the explicit
   * override path; quick mode + unlisted classes skip the check entirely.
   */
  prd: {
    mandatoryFor: readonly TaskClass[];
  };
}
