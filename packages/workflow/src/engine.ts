import type { ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import { readPrd, writeAuditExport } from './artifacts.js';
import { gateFor, readGateHistory, recordGate } from './gates.js';
import { applyTransition, nextPhase, stateForPhase } from './state-machine.js';
import type {
  GateResult,
  GateResultInput,
  Mode,
  Phase,
  TaskClass,
  TaskState,
  WorkflowGateConfig,
  WorkflowState,
} from './types.js';

/**
 * Store KV layout. The TaskState lives at `workflow:<taskId>`; the gate audit
 * lives at `audit:<taskId>` and is the AUTHORITATIVE record for every gate
 * outcome (S4 spec §11 OQ-5). `task.history` on the TaskState is a DERIVED view
 * the engine regenerates from the audit KV (debt-batch A / W1 collapse) so
 * there is a single write, single timestamp, single read-back — no drift.
 */
const ACTIVE_KEY = 'workflow:active';
const GATE_PHASES = ['spec', 'plan', 'verify'] as const satisfies ReadonlyArray<Phase>;

/**
 * Default gate config — used when the engine is constructed without an explicit
 * {@link WorkflowGateConfig} (the legacy 3-arg call shape every existing
 * consumer uses). Mirrors @noir-ai/core's `prd.mandatoryFor` default so the
 * soft PRD recommendation fires for feature/epic tasks out of the box.
 */
const DEFAULT_GATE_CONFIG: WorkflowGateConfig = {
  prd: { mandatoryFor: ['feature', 'epic'] },
};

/** Options for {@link WorkflowEngine.advance}. */
export interface AdvanceOpts {
  /**
   * Pass a gate without satisfying its criteria. Requires a non-empty `reason`
   * (validated here, in the engine — `recordGate` is policy-free). The landing
   * gate, if any, is recorded with `decision: 'forced'`. Mutually exclusive
   * with {@link skip}. This is ALSO the explicit-override path for the soft
   * PRD recommendation (debt-batch A / P4): supplying `--force <reason>` at the
   * spec gate of a mandatoryFor task with no PRD records `forced` with the
   * user's reason instead of the recommendation note.
   */
  force?: { reason?: string };
  /**
   * Jump directly to a phase, bypassing the FSM (the escape hatch for blocked /
   * out-of-order resumption). The landing is recorded as `jumpEntry` on the
   * TaskState; a landing gate-state (specified/planned/done) still records its
   * gate so the observable-checkpoint invariant holds. A no-op jump (target
   * equal to the current phase) returns the task unchanged without re-recording
   * any gate (W3 guard — the prior behavior double-stamped the audit).
   */
  to?: Phase;
  /**
   * Quick-mode: record the landing gate (if any) as `decision: 'skipped'`
   * instead of `approved`. The gate is still RECORDED — never silently dropped
   * (Noir §9.1 observable-checkpoint invariant) — only the decision changes.
   * Mutually exclusive with {@link force}.
   */
  skip?: true;
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
 *   • `opts.to` jumps past FSM edges and is recorded via `jumpEntry`,
 *   • (P4) the soft PRD recommendation at the spec gate for mandatoryFor tasks.
 *
 * Modes (Full/Quick) and cross-session resume are T5; MCP tools are T6 — the
 * engine stays mode-agnostic here and only stores `mode` on the TaskState.
 */
export class WorkflowEngine {
  private readonly gateConfig: WorkflowGateConfig;

  constructor(
    private readonly store: Store,
    /**
     * Project root — the engine is constructed with it so modes (quickPath
     * writes a spec stub via {@link writeSpec}) and future artifact flushes
     * (checkpoint/audit export) are self-contained. Public so the modes module
     * can pass it to {@link ArtifactWriter}.
     */
    readonly root: string,
    private readonly projectId: ProjectId,
    /**
     * Gate-config slice (debt-batch A / P4). Optional — the legacy 3-arg call
     * shape (every existing consumer) resolves to {@link DEFAULT_GATE_CONFIG}
     * (PRD recommendation fires for feature/epic). The daemon / CLI bridge
     * passes the resolved `prd.mandatoryFor` from NoirConfig so user overrides
     * take effect; tests pass an explicit shape to pin behavior.
     */
    gateConfig?: WorkflowGateConfig,
  ) {
    this.gateConfig = gateConfig ?? DEFAULT_GATE_CONFIG;
  }

  /**
   * Create a new task at draft/intake, persist it, and point `workflow:active`
   * at it. Re-starting an existing taskId overwrites it (intentional — the KV is
   * the source of truth, not a journal).
   *
   * `taskClass` (debt-batch A / P4) is optional and additive — legacy callers
   * (and existing tests) omit it; the soft PRD gate then never fires for the
   * task (consistent with the "additive, no-op when absent" rule). New callers
   * that want the recommendation pass `'feature'` / `'epic'` / etc.
   */
  async startTask(
    taskId: string,
    slug: string,
    mode: Mode,
    taskClass?: TaskClass,
  ): Promise<TaskState> {
    const task: TaskState = {
      taskId,
      slug,
      projectId: this.projectId,
      state: 'draft',
      phase: 'intake',
      mode,
      history: [],
      ...(taskClass !== undefined ? { taskClass } : {}),
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
   * {@link GateResult} is recorded — `approved` by default, `forced` (with the
   * reason) when `opts.force` is supplied, or `skipped` when `opts.skip` is
   * supplied (quick mode). `force` and `skip` are mutually exclusive. Jumps
   * bypass the FSM and additionally stamp `jumpEntry`.
   *
   * Single source of truth (W1): the gate is written ONCE to the audit KV via
   * {@link recordGate}, and `task.history` is RE-DERIVED from that KV. No
   * second write, no second timestamp — the S4 sub-ms drift is gone.
   */
  async advance(taskId: string, opts?: AdvanceOpts): Promise<TaskState> {
    const task = this.requireTask(taskId);

    // Policy: --force and skip are mutually exclusive gate decisions (a gate
    // can't be both forced AND skipped). Validated BEFORE any gate write so a
    // bad combination never leaves a partial audit trail behind.
    if (opts?.force && opts?.skip) {
      throw new Error('cannot combine --force and skip');
    }
    // Policy: --force requires a non-empty reason.
    if (opts?.force && !opts.force.reason?.trim()) {
      throw new Error('--force requires a reason');
    }

    const jump = opts?.to !== undefined;
    const targetPhase: Phase = jump ? (opts?.to as Phase) : this.nextPhaseOf(task);

    // W3 guard: a jump to the CURRENT phase is a no-op. Previously the engine
    // re-stamped the audit (the landing gate fired again), producing a spurious
    // duplicate entry. Return the task unchanged — no gate, no state change.
    if (jump && targetPhase === task.phase) {
      return task;
    }

    const targetState = stateForPhase(targetPhase);
    if (!jump) {
      // applyTransition surfaces the FSM's gate hint on illegal moves.
      applyTransition(task.state, targetState);
    }

    // Observable checkpoint: entering specified/planned/done always records a
    // gate — looked up from the target STATE (see gatePhaseForState).
    const gatePhase = gatePhaseForState(targetState);
    if (gatePhase !== null) {
      const decision = opts?.force ? 'forced' : opts?.skip ? 'skipped' : 'approved';
      // P4 soft PRD recommendation: when entering `specified` (the spec gate),
      // the task is mandatoryFor-eligible, no PRD artifact exists, and the user
      // did NOT supply --force, fold a recommendation note into the recorded
      // gate's `reason`. The advance STILL PROCEEDS — this is the "quiet
      // observable nudge" doctrine (§9.1): never a hard block, never silently
      // dropped. Quick-mode + unlisted taskClasses skip the check entirely;
      // --force records `forced` with the user's reason (the explicit override).
      const prdHint = this.prdRecommendation(task, gatePhase, opts);
      const input: GateResultInput = {
        phase: gatePhase,
        decision,
        // exactOptionalPropertyTypes is false; spread reason only when present.
        // Force-path wins over the soft hint (a user who forces is explicitly
        // accepting the recommendation; their reason is the override signal).
        ...(opts?.force
          ? { reason: opts.force.reason }
          : prdHint !== null
            ? { reason: prdHint }
            : {}),
      };
      // W1: record ONCE to the authoritative audit KV; derive history from it.
      recordGate(this.store, taskId, input);
      task.history = readGateHistory(this.store, taskId);
    }

    task.state = targetState;
    task.phase = targetPhase;
    if (jump) task.jumpEntry = targetPhase;
    task.updatedAt = Date.now();

    this.persist(task);
    return task;
  }

  /**
   * Compute the soft PRD-recommendation message (P4), or `null` when the
   * recommendation does NOT apply. The recommendation applies when ALL of:
   *   • the gate landing now is the spec gate (entering `specified`), AND
   *   • the task is in full mode (quick mode skips — quickPath writes a stub), AND
   *   • the task has a `taskClass` listed in `gateConfig.prd.mandatoryFor`, AND
   *   • no PRD artifact exists at `.noir/prd/<id>-<slug>.md` (readPrd), AND
   *   • the user did NOT supply --force (force is the explicit-override path).
   *
   * Returns the observable note (audited on the spec gate's `reason`) so a
   * downstream consumer (CLI status, workflow_status MCP tool) can surface it.
   */
  private prdRecommendation(task: TaskState, gatePhase: Phase, opts?: AdvanceOpts): string | null {
    if (gatePhase !== 'spec') return null;
    if (task.mode === 'quick') return null;
    const taskClass = task.taskClass;
    if (taskClass === undefined) return null;
    if (!this.gateConfig.prd.mandatoryFor.includes(taskClass)) return null;
    if (opts?.force) return null; // explicit override — user's reason wins
    if (readPrd(this.root, task.taskId, task.slug) !== null) return null;
    return `PRD recommended for ${taskClass} — provide one (noir-prd) or --force <reason> to skip`;
  }

  /** Read the persisted TaskState, or null if the task is unknown. */
  status(taskId: string): TaskState | null {
    const task = this.store.getState<TaskState>(workflowKey(taskId));
    if (!task) return null;
    // W1: re-derive history from the authoritative audit KV on every read, so
    // consumers see any externally-mutated audit (e.g. a manual KV write or a
    // future audit-import path) without waiting for the next advance.
    task.history = readGateHistory(this.store, taskId);
    return task;
  }

  /**
   * The taskId of the most-recently-started task (`workflow:active` in the
   * store KV), or `null` when no task has been started yet. Lets the MCP
   * `workflow_status` / `checkpoint` tools omit `taskId` and operate on the
   * active task.
   */
  activeTaskId(): string | null {
    return this.store.getState<string>(ACTIVE_KEY);
  }

  /**
   * Re-flush the current state to KV + flush the gate audit export to
   * `.noir/audit/<taskId>.json`. W2 (debt-batch A): the prior implementation
   * only bumped `updatedAt`, which every advance already does — vestigial.
   * Cross-session resume (`resumeTask`) reads `workflow:<id>` straight from the
   * KV and consumes nothing from this method; the S4 ledger noted the write was
   * dead. The fix is to WIRE the checkpoint to a real cross-tool artifact
   * flush: the audit JSON on disk (the S4 spec §11 OQ-5 "export to
   * `.noir/audit/<taskId>.json`" that {@link writeAuditExport} already
   * implemented but nothing called). The MCP `checkpoint { action:'save' }`
   * tool stays the public surface; its save now leaves a human-inspectable
   * audit JSON alongside the KV.
   */
  async checkpoint(taskId: string): Promise<void> {
    const task = this.store.getState<TaskState>(workflowKey(taskId));
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    task.updatedAt = Date.now();
    this.persist(task);
    // Flush the authoritative audit KV to disk for cross-tool inspection. The
    // audit is read straight from the KV (the SOT) so the JSON matches what
    // `status()` would report as `task.history`.
    writeAuditExport(this.root, taskId, readGateHistory(this.store, taskId));
  }

  /**
   * Set state directly to `blocked` (no FSM edge — the admin escape). The reason
   * is captured on the TaskState for surfacing in `noir.workflow_status`.
   *
   * W3: a SUPPLIED reason must be non-empty after trimming (mirrors the
   * `--force` policy). `setBlocked(id)` with no reason stays valid — it clears
   * no field and just flips state. A whitespace-only reason is rejected as
   * malformed (consistent with `--force`'s whitespace rejection).
   */
  async setBlocked(taskId: string, reason?: string): Promise<TaskState> {
    const task = this.requireTask(taskId);
    if (reason !== undefined) {
      const trimmed = reason.trim();
      if (trimmed.length === 0) {
        throw new Error('setBlocked reason must be non-empty (or omitted to leave unset)');
      }
      task.blockReason = trimmed;
    }
    task.state = 'blocked';
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
