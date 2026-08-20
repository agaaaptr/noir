import type { ProjectId } from '@noir-ai/core';
import type { Store } from '@noir-ai/store';
import { readPrd, writeAuditExport } from './artifacts.js';
import { gateFor, readGateHistory, recordGate } from './gates.js';
import { applyTransition, nextPhase, stateForPhase } from './state-machine.js';
import {
  type GateEvidence,
  type GateResult,
  type GateResultInput,
  type Mode,
  PHASES,
  type Phase,
  RESEARCH_ENTRY_TYPES,
  type ResearchEntry,
  type TaskClass,
  type TaskState,
  type WorkflowGateConfig,
  type WorkflowState,
} from './types.js';

/**
 * Store KV layout. The TaskState lives at `workflow:<taskId>`; the gate audit
 * lives at `audit:<taskId>` and is the AUTHORITATIVE record for every gate
 * outcome (spec §11 OQ-5). `task.history` on the TaskState is a DERIVED view
 * the engine regenerates from the audit KV (debt-batch A collapse) so
 * there is a single write, single timestamp, single read-back — no drift.
 */
const ACTIVE_KEY = 'workflow:active';
const GATE_PHASES = ['spec', 'plan', 'verify'] as const satisfies ReadonlyArray<Phase>;
/** c4-research-grounding: cap on a single research entry's text (token budget). */
const RESEARCH_TEXT_CAP = 220;

/**
 * Default gate config — used when the engine is constructed without an explicit
 * {@link WorkflowGateConfig} (the legacy 3-arg call shape every existing
 * consumer uses). Mirrors @noir-ai/core's `prd.mandatoryFor` default so the
 * soft PRD recommendation fires for feature/epic tasks out of the box.
 */
const DEFAULT_GATE_CONFIG: WorkflowGateConfig = {
  prd: { mandatoryFor: ['feature', 'epic'] },
  // c4-verify-gate-recovery: verify gate is OFF by default — a task with no
  // verify config behaves exactly as v1.9.4 (records approved/forced/skipped,
  // no evidence, no blocking). Opt-in via gateConfig.verify or NoirConfig.
  verify: { required: false, retryBudget: 2 },
  // c4-research-grounding: research is a SOFT grounding recommendation for
  // feature/epic (mirrors the PRD gate) — never a hard block.
  research: { recommendFor: ['feature', 'epic'], requireSource: true },
};

/** Options for {@link WorkflowEngine.advance}. */
export interface AdvanceOpts {
  /**
   * Pass a gate without satisfying its criteria. Requires a non-empty `reason`
   * (validated here, in the engine — `recordGate` is policy-free). The landing
   * gate, if any, is recorded with `decision: 'forced'`. Mutually exclusive
   * with {@link skip}. This is ALSO the explicit-override path for the soft
   * PRD recommendation (debt-batch A): supplying `--force <reason>` at the
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
   * any gate (guard — the prior behavior double-stamped the audit).
   */
  to?: Phase;
  /**
   * Quick-mode: record the landing gate (if any) as `decision: 'skipped'`
   * instead of `approved`. The gate is still RECORDED — never silently dropped
   * (Noir §9.1 observable-checkpoint invariant) — only the decision changes.
   * Mutually exclusive with {@link force}.
   */
  skip?: true;
  /**
   * c4-verify-gate-recovery: validation evidence for the verify gate. When the
   * verify gate is required for the task's class, advance into `done` evaluates
   * this evidence: all HARD checks exit 0 ⇒ `approved`; any HARD check non-zero
   * ⇒ `failed` (no transition); absent/stale evidence ⇒ pending (no transition,
   * no audit entry). `force`/`skip` override as usual.
   */
  evidence?: GateEvidence;
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
 * c4-verify-gate-recovery: thrown when the verify gate cannot admit `done`.
 * `kind: 'evidence-required'` = no fresh evidence was supplied (pending); the
 * advance did not transition and recorded NO gate. `kind: 'evidence-failed'` =
 * a HARD check failed; the advance recorded a `failed` decision WITH evidence
 * but did not transition. Both carry the `pendingGate` so the daemon/CLI handler
 * can surface a structured recovery offer (retry / force / skip / block).
 */
export class VerifyGateError extends Error {
  readonly kind: 'evidence-required' | 'evidence-failed' | 'budget-exhausted' | 'off-gate';
  readonly pendingGate: { gate: 'verify'; reason: string };
  readonly evidence?: GateEvidence;
  constructor(
    kind: 'evidence-required' | 'evidence-failed' | 'budget-exhausted' | 'off-gate',
    updatedAt: number,
    evidence?: GateEvidence,
  ) {
    super(`verify gate ${kind}`);
    this.name = 'VerifyGateError';
    this.kind = kind;
    this.evidence = evidence;
    this.pendingGate = {
      gate: 'verify',
      reason:
        kind === 'evidence-required'
          ? 'evidence-required'
          : kind === 'budget-exhausted'
            ? `verify retry budget exhausted at ${updatedAt}`
            : kind === 'off-gate'
              ? 'verify evidence supplied for an advance that does not cross the verify gate'
              : `evidence-failed at ${updatedAt}`,
    };
  }
}

/**
 * WorkflowEngine — drives an SDD task through its lifecycle.
 *
 * The engine is a thin orchestrator over three primitives:
 *   • the hand-rolled FSM ({@link applyTransition}) for legal forward moves,
 *   • {@link recordGate} for observable checkpoint audit, and
 *   • the store KV for persisted {@link TaskState}.
 *
 * Policy that did not belong in those primitives lives here:
 *   • `--force` requires a non-empty reason (validated before any gate write),
 *   • `blocked` / `abandoned` have no incoming FSM edges and are set directly,
 *   • `opts.to` jumps past FSM edges and is recorded via `jumpEntry`,
 *   • the soft PRD recommendation at the spec gate for mandatoryFor tasks.
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
     * Gate-config slice (debt-batch A). Optional — the legacy 3-arg call
     * shape (every existing consumer) resolves to {@link DEFAULT_GATE_CONFIG}
     * (PRD recommendation fires for feature/epic). The daemon / CLI bridge
     * passes the resolved `prd.mandatoryFor` from NoirConfig so user overrides
     * take effect; tests pass an explicit shape to pin behavior.
     */
    gateConfig?: WorkflowGateConfig,
  ) {
    // Deep-merge with defaults: a partial gateConfig (e.g., only prd) must
    // not strip verify/research defaults — the engine accesses all three.
    this.gateConfig = gateConfig
      ? {
          prd: gateConfig.prd ?? DEFAULT_GATE_CONFIG.prd,
          verify: gateConfig.verify ?? DEFAULT_GATE_CONFIG.verify,
          research: gateConfig.research ?? DEFAULT_GATE_CONFIG.research,
        }
      : DEFAULT_GATE_CONFIG;
  }

  /**
   * Create a new task at draft/intake, persist it, and point `workflow:active`
   * at it. Re-starting an existing taskId overwrites it (intentional — the KV is
   * the source of truth, not a journal).
   *
   * `taskClass` (debt-batch A) is optional and additive — legacy callers
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
    // Re-start overwrites the TaskState; the DERIVED KV (audit + research) must
    // be reset too, else status() re-derives the prior run's full gate history
    // and stale research findings onto the "fresh" draft task. Only clear when a
    // prior task existed (a first start must leave the KV ABSENT, not `[]` — the
    // `null`-vs-empty contract readGateHistory/readResearch rely on).
    if (this.store.getState<TaskState>(`workflow:${taskId}`) !== null) {
      this.store.setState<GateResult[]>(`audit:${taskId}`, []);
      this.store.setState<ResearchEntry[]>(`research:${taskId}`, []);
    }
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
   * Single source of truth: the gate is written ONCE to the audit KV via
   * {@link recordGate}, and `task.history` is RE-DERIVED from that KV. No
   * second write, no second timestamp — the sub-ms drift is gone.
   */
  async advance(taskId: string, opts?: AdvanceOpts): Promise<TaskState> {
    const task = this.requireTask(taskId);

    // Terminal states are terminal: `done` / `abandoned` have no outgoing FSM
    // edge, so a jump (`opts.to`) must not resurrect them either — otherwise a
    // completed task could be jumped back into any phase and re-record gates.
    this.assertNotTerminal(task);

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

    // c4-research-grounding: the clarify→spec exit criterion. Open questions
    // raised during clarify block the transition to `specified` (the spec gate)
    // unless the advance carries --force/--skip (the escapable-observable
    // invariant). Jumps bypass this (a jump is an explicit out-of-order move).
    const jumpEarly = opts?.to !== undefined;
    const nextPhaseGuess = jumpEarly ? (opts?.to as Phase) : this.nextPhaseOf(task);
    if (
      !jumpEarly &&
      nextPhaseGuess === 'spec' &&
      (task.openQuestions?.length ?? 0) > 0 &&
      !opts?.force &&
      !opts?.skip
    ) {
      const count = task.openQuestions?.length ?? 0;
      throw new Error(
        `clarify→spec blocked: ${count} open question(s) unresolved (resolve them, or --force/--skip)`,
      );
    }

    const jump = opts?.to !== undefined;
    const targetPhase: Phase = jump ? (opts?.to as Phase) : this.nextPhaseOf(task);

    // Guard: a jump to the CURRENT phase is a no-op. Previously the engine
    // re-stamped the audit (the landing gate fired again), producing a spurious
    // duplicate entry. Return the task unchanged — no gate, no state change.
    //
    // EXCEPT when the task is BLOCKED: setBlocked flips state to 'blocked' but
    // leaves phase untouched, and blocked has no FSM edges, so the only way out
    // is an explicit jump. A jump to the SAME phase on a blocked task is exactly
    // that unblock — fall through so `targetState = stateForPhase(targetPhase)`
    // reassigns the phase's live state (blocked → executing/specified/…). The
    // backward-jump suppression below already treats the equal phase as backward,
    // so no duplicate gate is recorded. Without this, a task blocked mid-phase
    // could only escape lossily (jump forward to skip work, or backward to regress).
    if (jump && targetPhase === task.phase && task.state !== 'blocked') {
      // A no-op jump must not silently swallow a force/skip/evidence that was
      // intended for a gate landing — reject it explicitly.
      if (opts?.force !== undefined || opts?.skip === true || opts?.evidence !== undefined) {
        throw new Error(
          `cannot force/skip/verify a jump to the current phase (${task.phase}) — it is a no-op`,
        );
      }
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

    // Guard: a BACKWARD jump (target phase at-or-before the current phase) must
    // NOT re-record a gate that ALREADY fired — the authoritative audit carries
    // the original decision, and the audit is append-only. The suppression is
    // CONDITIONAL on the gate actually being in the audit: a task that JUMPED
    // over a gate (e.g. clarifying → verifying via a forward jump) has NOT fired
    // the intermediate gate, so jumping back to it MUST record it (the
    // observable-checkpoint invariant). The jump still LANDS; `jumpEntry` below
    // records where. Forward jumps (incl. the normal FSM path) record as before.
    const gateAlreadyFired = gatePhase !== null && task.history.some((g) => g.phase === gatePhase);
    const backwardJump =
      jump &&
      gatePhase !== null &&
      gateAlreadyFired &&
      PHASES.indexOf(targetPhase) <= PHASES.indexOf(task.phase);
    // Fail fast: evidence is ONLY meaningful when this advance crosses the
    // verify gate (lands on `done`). Supplying evidence for any other advance
    // (e.g. running `noir task verify` from `executing`, which lands on
    // `verifying`) would silently discard the checks and let the CLI report a
    // false "gate approved". Throw before any write so nothing is lost.
    if (opts?.evidence !== undefined && gatePhase !== 'verify') {
      throw new VerifyGateError('off-gate', task.updatedAt);
    }
    if (gatePhase !== null && !backwardJump) {
      const forced = opts?.force !== undefined;
      const skipped = opts?.skip === true;
      // c4-verify-gate-recovery: the verify gate is evidence-backed when the
      // task's class is configured `verify.required`. `force`/`skip` override
      // the evaluation (the explicit escapes), exactly like the other gates.
      // Default OFF — a task with no verify config takes the legacy path
      // (decision approved/forced/skipped, no evidence, no blocking).
      if (gatePhase === 'verify' && this.verifyRequiredFor(task) && !forced && !skipped) {
        const evidence = opts?.evidence;
        // Stale evidence (ran before the last TaskState update) = no evidence.
        const fresh =
          evidence !== undefined && evidence.ranAt >= task.updatedAt ? evidence : undefined;
        if (fresh === undefined) {
          // No fresh evidence: do NOT transition, do NOT record — "pending" is
          // the absence of a decision. Throw so the daemon/CLI handler surfaces
          // a clear pendingGate envelope + recovery options.
          throw new VerifyGateError('evidence-required', task.updatedAt);
        }
        // Empty checks is FAUX evidence: `Array.some` on [] returns false, so a
        // {ranAt, checks:[], summary} payload would otherwise be admitted as
        // "all HARD green" and pass a required verify gate with zero actual
        // validation. Treat it as no evidence (same defense the research-
        // grounding work guards against).
        if (fresh.checks.length === 0) {
          throw new VerifyGateError('evidence-required', task.updatedAt, fresh);
        }
        const hardFail = fresh.checks.some(
          (c) => c.exitCode !== 0 && (c.tier ?? 'hard') === 'hard',
        );
        if (hardFail) {
          // Enforce the verify retry budget: count prior failed verify decisions
          // for this task and refuse to record ANOTHER (unbounded retry) once
          // the budget is exhausted. The budget comes from gate config; the
          // default (2) keeps a couple of retries before the gate hard-stops.
          const priorFailures = readGateHistory(this.store, taskId).filter(
            (g) => g.phase === 'verify' && g.decision === 'failed',
          ).length;
          const budget = this.gateConfig.verify.retryBudget;
          if (priorFailures >= budget) {
            task.history = readGateHistory(this.store, taskId);
            throw new VerifyGateError('budget-exhausted', task.updatedAt, fresh);
          }
          // Evidence ran and a HARD check failed: record a `failed` decision
          // WITH evidence (a visible failure — observable-checkpoint invariant),
          // but do NOT transition to `done`. Throw so the caller surfaces recovery.
          recordGate(this.store, taskId, {
            phase: 'verify',
            decision: 'failed',
            evidence: fresh,
            reason: fresh.summary,
          });
          task.history = readGateHistory(this.store, taskId);
          throw new VerifyGateError('evidence-failed', task.updatedAt, fresh);
        }
        // Evidence present, all HARD checks green ⇒ record `approved` with
        // evidence (SOFT failures are flagged in the summary but don't block).
        const input: GateResultInput = {
          phase: gatePhase,
          decision: 'approved',
          evidence: fresh,
          ...(fresh.summary ? { reason: fresh.summary } : {}),
        };
        recordGate(this.store, taskId, input);
        task.history = readGateHistory(this.store, taskId);
      } else {
        const decision = opts?.force ? 'forced' : opts?.skip ? 'skipped' : 'approved';
        // Soft PRD recommendation: when entering `specified` (the spec gate),
        // the task is mandatoryFor-eligible, no PRD artifact exists, and the user
        // did NOT supply --force, fold a recommendation note into the recorded
        // gate's `reason`. The advance STILL PROCEEDS — this is the "quiet
        // observable nudge" doctrine (§9.1): never a hard block, never silently
        // dropped. Quick-mode + unlisted taskClasses skip the check entirely;
        // --force records `forced` with the user's reason (the explicit override).
        const prdHint = this.prdRecommendation(task, gatePhase, opts);
        const researchHint = this.researchRecommendation(task, gatePhase, opts);
        const softHint =
          prdHint !== null && researchHint !== null
            ? `${prdHint}; ${researchHint}`
            : (prdHint ?? researchHint);
        const input: GateResultInput = {
          phase: gatePhase,
          decision,
          // exactOptionalPropertyTypes is false; spread reason only when present.
          // Force-path wins over the soft hints (a user who forces is explicitly
          // accepting the recommendations; their reason is the override signal).
          ...(opts?.force
            ? { reason: opts.force.reason }
            : softHint !== null
              ? { reason: softHint }
              : {}),
        };
        // Record ONCE to the authoritative audit KV; derive history from it.
        recordGate(this.store, taskId, input);
        task.history = readGateHistory(this.store, taskId);
      }
    }

    task.state = targetState;
    task.phase = targetPhase;
    if (jump) task.jumpEntry = targetPhase;
    task.updatedAt = Date.now();

    this.persist(task);
    return task;
  }

  /**
   * Compute the soft PRD-recommendation message, or `null` when the
   * recommendation does NOT apply. The recommendation applies when ALL of:
   *   • the gate landing now is the spec gate (entering `specified`), AND
   *   • the task is in full mode (quick mode skips — quickPath writes a stub), AND
   *   • the task has a `taskClass` listed in `gateConfig.prd.mandatoryFor`, AND
   *   • no PRD artifact exists at `.noir/prd/PRD-<NNNN>-<id>-<slug>.md` (readPrd), AND
   *   • the user did NOT supply --force (force is the explicit-override path).
   *
   * Returns the observable note (audited on the spec gate's `reason`) so a
   * downstream consumer (CLI status, workflow_status MCP tool) can surface it.
   */
  /**
   * c4-verify-gate-recovery: resolve whether the verify gate is evidence-backed
   * for this task. `required` may be a boolean (all tasks) or a per-class map.
   * A task with no `taskClass` follows the boolean default (false ⇒ off).
   */
  private verifyRequiredFor(task: TaskState): boolean {
    const required = this.gateConfig.verify.required;
    if (typeof required === 'boolean') return required;
    if (task.taskClass === undefined) return false;
    return required[task.taskClass] === true;
  }

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

  /**
   * c4-research-grounding: a SOFT research-grounding recommendation at the spec
   * gate (mirrors {@link prdRecommendation}). Fires when the task's class is in
   * `research.recommendFor` AND `research:<taskId>` has no source-backed findings
   * (only absent or assumption-only entries without sources). Never a hard block
   * — the advance always proceeds; `--force` is the explicit override.
   */
  private researchRecommendation(
    task: TaskState,
    gatePhase: Phase,
    opts?: AdvanceOpts,
  ): string | null {
    if (gatePhase !== 'spec') return null;
    if (task.mode === 'quick') return null;
    const taskClass = task.taskClass;
    if (taskClass === undefined) return null;
    if (!this.gateConfig.research.recommendFor.includes(taskClass)) return null;
    if (opts?.force) return null;
    const findings = this.readResearch(task.taskId);
    // "Source-backed" = any entry with a source, or a grounding-fact. If none,
    // the task is entering spec without grounding → recommend.
    const hasGrounding = findings.some(
      (f) => f.type === 'grounding-fact' || (f.source !== undefined && f.source.trim().length > 0),
    );
    if (hasGrounding) return null;
    return `research grounding recommended for ${taskClass} — record findings (noir task research record) or --force <reason> to skip`;
  }

  /** Read the persisted TaskState, or null if the task is unknown. */
  status(taskId: string): TaskState | null {
    const task = this.store.getState<TaskState>(workflowKey(taskId));
    if (!task) return null;
    // Re-derive history from the authoritative audit KV on every read, so
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
   * `.noir/audit/<taskId>.json` (debt-batch A): the prior implementation
   * only bumped `updatedAt`, which every advance already does — vestigial.
   * Cross-session resume (`resumeTask`) reads `workflow:<id>` straight from the
   * KV and consumes nothing from this method; the ledger noted the write was
   * dead. The fix is to WIRE the checkpoint to a real cross-tool artifact
   * flush: the audit JSON on disk (the spec §11 OQ-5 "export to
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
   * A SUPPLIED reason must be non-empty after trimming (mirrors the
   * `--force` policy). `setBlocked(id)` with no reason stays valid — it clears
   * no field and just flips state. A whitespace-only reason is rejected as
   * malformed (consistent with `--force`'s whitespace rejection).
   */
  async setBlocked(taskId: string, reason?: string): Promise<TaskState> {
    const task = this.requireTask(taskId);
    // Terminal tasks stay terminal: flipping a done/abandoned task to `blocked`
    // would bypass the advance() terminal guard and let a later jump resurrect
    // the completed task and re-record its gates. Same policy as advance().
    this.assertNotTerminal(task);
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
    // Terminal tasks stay terminal: `abandon` on a done/abandoned task THROWS
    // (assertNotTerminal) rather than relabelling it (done stays done — it was
    // verified). advance() and setBlocked share the same terminal policy.
    this.assertNotTerminal(task);
    task.state = 'abandoned';
    task.updatedAt = Date.now();
    this.persist(task);
    return task;
  }

  /**
   * c4-research-grounding: append a research-finding record to `research:<taskId>`
   * (append-only, mirrors the gate audit). `source` is required for non-
   * `grounding-fact` entries when `gateConfig.research.requireSource` is on
   * (defeats the "faux context" failure mode); `text` is length-capped.
   */
  recordResearch(taskId: string, entry: Omit<ResearchEntry, 'at'>): ResearchEntry {
    this.requireTask(taskId); // validate the task exists
    if (!RESEARCH_ENTRY_TYPES.includes(entry.type)) {
      throw new Error(`invalid research entry type '${entry.type}'`);
    }
    const text = entry.text?.trim() ?? '';
    if (text.length === 0) throw new Error('research entry text must be non-empty');
    if (text.length > RESEARCH_TEXT_CAP) {
      throw new Error(`research entry text exceeds ${RESEARCH_TEXT_CAP} chars`);
    }
    const requireSource = this.gateConfig.research.requireSource;
    if (requireSource && entry.type !== 'grounding-fact') {
      if (!entry.source || entry.source.trim().length === 0) {
        throw new Error(`research entry of type '${entry.type}' requires a source`);
      }
    }
    const key = `research:${taskId}`;
    const prior = this.store.getState<ResearchEntry[]>(key) ?? [];
    const recorded: ResearchEntry = { ...entry, text, at: Date.now() };
    this.store.setState<ResearchEntry[]>(key, [...prior, recorded]);
    return recorded;
  }

  /** Read the research findings for a task (empty array when none recorded). */
  readResearch(taskId: string): ResearchEntry[] {
    return this.store.getState<ResearchEntry[]>(`research:${taskId}`) ?? [];
  }

  /**
   * c4-research-grounding: set the task's open questions (raised during
   * clarify). When non-empty, the clarify→spec transition is gated unless the
   * advance carries `force`/`skip` (the observable+escapable invariant).
   */
  setOpenQuestions(taskId: string, questions: string[]): TaskState {
    const task = this.requireTask(taskId);
    task.openQuestions = questions.filter((q) => typeof q === 'string' && q.trim().length > 0);
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

  /** Terminal-state guard shared by advance / setBlocked / abandon: `done` and
   *  `abandoned` have no outgoing FSM edge, so no write may flip them back into
   *  the lifecycle (that would resurrect a completed task and re-record gates). */
  private assertNotTerminal(task: TaskState): void {
    if (task.state === 'done' || task.state === 'abandoned') {
      throw new Error(
        `task is ${task.state} (terminal) — it cannot be advanced or jumped; start a new task`,
      );
    }
  }

  private persist(task: TaskState): void {
    this.store.setState<TaskState>(workflowKey(task.taskId), task);
  }
}

function workflowKey(taskId: string): string {
  return `workflow:${taskId}`;
}
