import type { ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import { gateFor, recordGate } from './gates.js';
import { applyTransition, nextPhase, stateForPhase } from './state-machine.js';
import type { GateResult, Mode, Phase, TaskState, WorkflowState } from './types.js';

/**
 * Store KV layout (single source of truth for machine state):
 *   workflow:active   → taskId of the most recently started task
 *   workflow:<taskId> → TaskState (JSON)
 * Audit decisions live at `audit:<taskId>` (see {@link recordGate}).
 */
const ACTIVE_KEY = 'workflow:active';
const GATE_PHASES = ['spec', 'plan', 'verify'] as const satisfies ReadonlyArray<Phase>;

/** Options for {@link WorkflowEngine.advance}. */
export interface AdvanceOpts {
  /**
   * Pass a gate without satisfying its criteria. Requires a non-empty `reason`
   * (validated here, in the engine — `recordGate` is policy-free). The landing
   * gate, if any, is recorded with `decision: 'forced'`.
   */
  force?: { reason?: string };
  /**
   * Jump directly to a phase, bypassing the FSM (the escape hatch for blocked /
   * out-of-order resumption). The landing is recorded as `jumpEntry` on the
   * TaskState; a landing gate-state (specified/planned/done) still records its
   * gate so the observable-checkpoint invariant holds.
   */
  to?: Phase;
}

/**
 * The phase whose gate admits entry into `state` (the inverse of {@link gateFor}).
 *
 * The verify gate fires on entering `done` — but `done` is `stateForPhase('document')`,
 * so the target *phase* of that transition is `document`, not `verify`. The gate
 * must therefore be looked up from the target *state*, not the target phase.
 */
function gatePhaseForState(state: WorkflowState): Phase | null {
  for (const p of GATE_PHASES) {
    if (gateFor(p) === state) return p;
  }
  return null;
}

/**
 * WorkflowEngine — drives an SDD task through its lifecycle.
 *
 * The engine is a thin orchestrator over three T1–T3 primitives:
 *   • the hand-rolled FSM ({@link applyTransition}) for legal forward moves,
 *   • {@link recordGate} for observable checkpoint audit, and
 *   • the store KV for persisted {@link TaskState}.
 *
 * Policy that did not belong in T1/T2 lives here:
 *   • `--force` requires a non-empty reason (validated before any gate write),
 *   • `blocked` / `abandoned` have no incoming FSM edges and are set directly,
 *   • `opts.to` jumps past FSM edges and is recorded via `jumpEntry`.
 *
 * Modes (Full/Quick) and cross-session resume are T5; MCP tools are T6 — the
 * engine stays mode-agnostic here and only stores `mode` on the TaskState.
 */
export class WorkflowEngine {
  constructor(
    private readonly store: Store,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: project root for T5 artifact flushes (checkpoint/writeSpec/…); stored at construction so the engine is self-contained.
    private readonly root: string,
    private readonly projectId: ProjectId,
  ) {}

  /**
   * Create a new task at draft/intake, persist it, and point `workflow:active`
   * at it. Re-starting an existing taskId overwrites it (intentional — the KV is
   * the source of truth, not a journal).
   */
  async startTask(taskId: string, slug: string, mode: Mode): Promise<TaskState> {
    const task: TaskState = {
      taskId,
      slug,
      projectId: this.projectId,
      state: 'draft',
      phase: 'intake',
      mode,
      history: [],
      updatedAt: Date.now(),
    };
    this.persist(task);
    this.store.setState<string>(ACTIVE_KEY, taskId);
    return task;
  }

  /**
   * Advance `taskId` to its next phase, or jump with `opts.to`.
   *
   * At a gate-landing state (entering `specified` / `planned` / `done`) a
   * {@link GateResult} is recorded — `approved` by default, or `forced` (with the
   * reason) when `opts.force` is supplied. Jumps bypass the FSM and additionally
   * stamp `jumpEntry`.
   */
  async advance(taskId: string, opts?: AdvanceOpts): Promise<TaskState> {
    const task = this.requireTask(taskId);

    // Policy: --force requires a non-empty reason. Validated BEFORE any gate
    // write so a bad force never leaves a partial audit trail behind.
    if (opts?.force && !opts.force.reason?.trim()) {
      throw new Error('--force requires a reason');
    }

    const jump = opts?.to !== undefined;
    const targetPhase: Phase = jump ? (opts?.to as Phase) : this.nextPhaseOf(task);

    const targetState = stateForPhase(targetPhase);
    if (!jump) {
      // applyTransition surfaces the FSM's gate hint on illegal moves.
      applyTransition(task.state, targetState);
    }

    // Observable checkpoint: entering specified/planned/done always records a
    // gate — looked up from the target STATE (see gatePhaseForState).
    const gatePhase = gatePhaseForState(targetState);
    if (gatePhase !== null) {
      const decision = opts?.force ? 'forced' : 'approved';
      const gate: GateResult = {
        phase: gatePhase,
        decision,
        // exactOptionalPropertyTypes is false; spread reason only when forced.
        ...(opts?.force ? { reason: opts.force.reason } : {}),
        at: Date.now(),
      };
      recordGate(this.store, taskId, gate);
      task.history.push(gate);
    }

    task.state = targetState;
    task.phase = targetPhase;
    if (jump) task.jumpEntry = targetPhase;
    task.updatedAt = Date.now();

    this.persist(task);
    return task;
  }

  /** Read the persisted TaskState, or null if the task is unknown. */
  status(taskId: string): TaskState | null {
    return this.store.getState<TaskState>(workflowKey(taskId));
  }

  /**
   * Re-flush the current state to KV. In T4 every advance already persists, so
   * this is the explicit "mark a checkpoint" hook (bumps `updatedAt`); T5
   * deepens it to flush artifacts + audit export for cross-session resume.
   */
  async checkpoint(taskId: string): Promise<void> {
    const task = this.store.getState<TaskState>(workflowKey(taskId));
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    task.updatedAt = Date.now();
    this.persist(task);
  }

  /**
   * Set state directly to `blocked` (no FSM edge — the admin escape). The reason
   * is captured on the TaskState for surfacing in `noir.workflow_status`.
   */
  async setBlocked(taskId: string, reason?: string): Promise<TaskState> {
    const task = this.requireTask(taskId);
    task.state = 'blocked';
    if (reason) task.blockReason = reason;
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  /** Set state directly to `abandoned` (terminal; no FSM edge). */
  async abandon(taskId: string): Promise<TaskState> {
    const task = this.requireTask(taskId);
    task.state = 'abandoned';
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  private nextPhaseOf(task: TaskState): Phase {
    const next = nextPhase(task.state);
    if (next === null) {
      throw new Error(`No next phase from state ${task.state}`);
    }
    return next;
  }

  private requireTask(taskId: string): TaskState {
    const task = this.store.getState<TaskState>(workflowKey(taskId));
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    return task;
  }

  private persist(task: TaskState): void {
    this.store.setState<TaskState>(workflowKey(task.taskId), task);
  }
}

function workflowKey(taskId: string): string {
  return `workflow:${taskId}`;
}
