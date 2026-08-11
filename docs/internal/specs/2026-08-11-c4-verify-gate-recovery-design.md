# C4 Verify-Gate Automation + Recovery — evidence, blocking, and failure recovery (spec)

> Capability-04 delta: the verify gate today **records a decision only** — `engine.advance()` runs no external commands, `noir-verifying` is a generic host-side evidence skill with no gate connection, and the only failure escapes (`setBlocked`/`abandon`/`jump`) are engine-level. The C4 acceptance criterion demands: "Verify gate triggers automated validation (tests/lint/CI) and recovery flows exist for CI/test/publish failure and merge/spec conflicts — a failing validation blocks advance and a recovery path is offered."
>
> This spec makes the verify gate **evidence-backed and recovery-capable** while keeping the engine host-agnostic (it never shells out — it owns the gate contract + evidence policy; the host executes). It is the first **semantic** change to the FSM's gate behavior since v1.9.0, so it is written to be strictly backward-compatible: blocking engages only when a task's class/mode has required checks configured (mirroring how an absent `taskClass` disables the PRD gate today).
>
> Internal docs follow `docs/internal/specs/`. Research basis: pre-transition hard gate + post-run evidence record (Claude Code hooks model), block-and-offer-recovery with bounded retry (bors/Uber SubmitQueue), HARD/SOFT gate tiering, evidence reproducibility (SRE hermetic builds), and the DoD-as-default-gate checklist (DORA / GitScrum / Microsoft Code-with-Engineering-Playbook).

## Goal

1. The **verify gate admits `done` only with fresh, passing evidence** — when required checks are configured. Failed validation **blocks advance** and offers a structured recovery path (retry / force / skip / block).
2. Every validation run is **recorded as evidence** in the audit (command, exit code, output digest, ranAt), so "no evidence yet", "evidence failed", and "user escaped" are distinct states — never conflated with `skipped`.
3. Recovery flows exist for **CI/test/publish failure and merge/spec conflicts**, reusing the engine's existing artifact conflict-resolution seam and the `blocked` state (now reachable via the surface-wiring spec's `workflow_block`).
4. The **document phase produces artifacts**: decision + changelog stubs are wired (today they are dead API), and a provider-gated agent-memory consolidation hook fires at `done`.

## Scope

### S1 — Evidence model on the gate record

**`packages/workflow/src/types.ts`** — widen `GateResultInput` / `GateResult` additively:

```ts
export interface CheckEvidence {
  name: string;            // check name, e.g. "test", "lint", "typecheck"
  exitCode: number;
  outputDigest: string;    // stable hash of the run output (or artifact path)
  command: string;         // the exact command run (for reproducibility)
}
export interface GateEvidence {
  ranAt: number;
  checks: CheckEvidence[];
  summary: string;         // 1-line human digest, e.g. "14 passed, 1 failed"
}
// GateResultInput gains:
evidence?: GateEvidence;
// GateResult decision set widens: 'approved' | 'forced' | 'skipped' | 'failed'
// 'failed' = evidence ran and failed (recovery offered). 'pending' is NOT
// recorded — it is the absence of a decision (advance did not land).
```

- `recordGate` (`gates.ts:49-55`) keeps its append-only write; it just accepts the wider shape. `TaskState.history` derives unchanged.
- A `failed` decision must carry `evidence`; a `forced` decision may carry evidence (the user overrode a failed run). Validation lives in the engine, not `recordGate` (policy-free, as today).

### S2 — Verify-gate evaluation in `advance` (pre-transition hard gate)

**`packages/workflow/src/engine.ts`** — `advance(taskId, opts)` gains gate evaluation for the verify gate (target `done`):

1. When `verify` is required for the task's class/mode (S4) and `opts` carries **no fresh evidence** (`opts.evidence` absent, or `ranAt` older than the last `TaskState.updatedAt`): **do not transition**. Return the task unchanged with a machine-readable `pendingGate: { gate: 'verify', reason: 'evidence-required' }` (a new field on the returned status shape, additive). The audit gets **no** entry — "no evidence yet" is absence, not `skipped`.
2. When evidence is present and **all checks exit 0**: transition to `done`, record the gate as `approved` with `evidence`.
3. When evidence is present and **any check non-zero**: **do not transition**; record the gate as `failed` with `evidence` (this IS an audit entry — a visible failure, mirroring the observable-checkpoint invariant) and return a recovery shape (S6).
4. `opts.force {reason}` bypasses 1–3 exactly as today (records `forced`; evidence optional but recommended so the override is legible). `opts.skip` records `skipped` (user escape). These are unchanged.
5. **Backward compatibility:** when `verify` is not required (default), behavior is byte-identical to today — `advance` records `approved`/`forced`/`skipped` with no evidence and no blocking.

**New evidence input** — `AdvanceOpts` gains `evidence?: GateEvidence` (optional, additive). The engine never executes commands (grep-guard: no `child_process` in `packages/workflow/src`, enforced by a lint/test guard).

### S3 — Evidence submission + `noir task verify`

The host/user runs checks; the engine records. Three submission paths:

- **`packages/daemon/src/server.ts`** — `workflow_advance` input gains `evidence: { ranAt, checks: [{name, exitCode, outputDigest, command}], summary }` (optional), forwarded to `engine.advance(id, { evidence })`. Degraded (read-only) → write envelope, unchanged.
- **`packages/cli/src/commands/task.ts`** — new `noir task verify [--check <name> ...]`:
  - Resolves the check set from the task's config (`workflow.verify.checks`) or, when absent, the **detected-stack defaults** from `detectStack()` (`packages/create/src/stack-detect.ts`), e.g. `pnpm test` / `pnpm lint` / `pnpm typecheck` for a pnpm TS project. No checks resolvable → exit with a clear "no verify checks configured" (2) rather than inventing commands.
  - Executes each check as a **child process on the user's machine** (explicit user invocation — the CLI, not the engine, owns shell access), captures exit code + output digest (`crypto.createHash('sha256')` of the run output; full output not stored), and calls `workflow_advance` with the assembled `evidence`.
  - Failing run → prints the failed check names + digest + the recovery options (S6), exit 1.
- **`noir-verifying` skill** (`packages/skills/builtin/noir-verifying/SKILL.md`) — becomes gate-connected: its instructions now direct the host to run `noir task verify` as the verify-gate execution step (the existing "the output IS the evidence" principle is preserved; the CLI is the concrete executor). Add a cross-reference in the skill's WHEN/follow-up section.

### S4 — Required-checks config (taskClass/mode-gated)

**`packages/workflow/src/types.ts`** — `WorkflowGateConfig` gains a `verify` slice (default = off, backward compatible):

```ts
export interface WorkflowGateConfig {
  prd: { mandatoryFor: readonly TaskClass[] };
  verify: {
    required: boolean | Partial<Record<TaskClass, boolean>>; // default false
    retryBudget: number;      // default 2 — auto-retries offered before block
    checks?: { name: string; command: string }[]; // defaults resolved by the CLI from detectStack()
  };
}
```

**`packages/core/src/config.ts`** — `NoirConfigSchema` gains a `workflow.gate.verify` block (or `gate: { verify: {...} }`) with the same shape; the daemon/CLI bridge maps it to `WorkflowGateConfig` at construction (the S5 bridge from the surface-wiring spec). Default posture: **`required: false`** for `quick-task`/`spike`/`bugfix`, **`required: true`** for `feature`/`epic` when the block is present; absent block → fully off.

**Right-sizing** (research): cheap checks first — a `quick-task` with `required: true` runs `typecheck` only; `feature`/`epic` run the full configured set. The CLI enforces this ordering.

### S5 — HARD vs SOFT gate tiering

Not every check should hard-block (research: DORA/SRE math — flaky checks must not gate merges). `WorkflowGateConfig.verify.checks[].tier` = `'hard' | 'soft'`:

- **`hard`** (default for test/typecheck/build): participates in S2's blocking — any non-zero exit blocks advance and offers recovery.
- **`soft`** (e.g. docs-freshness, perf-budget, PRD-note, flaky-quarantine): non-zero exit is **recorded as `soft-fail`** on the evidence but does NOT block; the advance proceeds to `approved` with the soft-fail flagged in `summary` (observable, never silent). Toggle per check in config; `noir task verify` renders soft-fails distinctly.

### S6 — Block-and-offer recovery

When the verify gate records `failed` (S2.3) or a hard check fails, the CLI/daemon surfaces a **structured recovery offer**:

1. **Retry (fix-and-rerun):** run `noir task verify` again after the user fixes; within `retryBudget` (default 2) the same task re-evaluates normally.
2. **Force:** `noir task advance --force <reason>` records `forced` (with the failed evidence attached) and lands `done` — the explicit escape, never silent.
3. **Skip:** `noir task advance --skip` records `skipped` (user escape).
4. **Block:** `noir task block "verify-failed: <summary>"` → task is `blocked` with a structured `blockReason` (via the surface-wiring `workflow_block`); `workflow_resume`/`noir task resume` then surfaces it and re-running verification is the first suggested next action. On retry-budget exhaustion the CLI offers block as the default.
5. **Publish failure:** mirrors SRE release engineering — the release spec (`2026-08-11-c4-release-phase-design.md`) owns build-once/idempotent/rollback; this spec only requires that a publish failure surfaced by the host can set the task `blocked` with a structured reason and be resumed.

### S7 — Merge/spec-conflict recovery

- **Merge/spec conflict on artifact write** (a spec/plan being regenerated over a diverged file) → flow through the **existing conflict-resolution seam** (`WorkflowConflictResolver`, `artifacts.ts:50-98`): the engine's conflict resolver can return `cancel`, which now maps to a **recoverable block** (`setBlocked('artifact-conflict: <relPath>')`) so the task is resumable rather than silently overwritten. `rename`/`duplicate`/`preserve`/`replace` remain the other resolutions, unchanged.
- **Merge conflict on code** (git-level) is host territory; Noir records it: when the host reports a merge conflict during `execute`, the CLI surfaces `noir task block "merge-conflict: <path>"` as the recovery path (documented in the recovery help text, not engine logic).

### S8 — Document-phase artifact wiring

- **`packages/workflow/src/artifacts.ts`** — `writeDecisionStub` (L240) and `writeChangelogStub` (L270) are exported but have **zero callers**. Wire them into the document phase: on transition into `done` (verify gate `approved`/`forced`), the engine's `checkpoint()` (or the CLI on the `advance` result) writes a decision stub (`docs/decisions/00XX-<slug>.md`) and a changelog entry (`CHANGELOG.md` top section) via the conflict seam. Because these are external-file writes, the CLI is the natural caller (the engine stays file-surface-light — see Non-goals); the spec requires the wiring to live in `task.ts`/`status.ts` on a confirmed `done`, with a `--no-artifacts` escape.
- **Agent-memory hook:** `@noir-ai/memory` consolidation (`memory/src/consolidate.ts`) is provider-gated and already exists. The document phase now invokes it (or a CLI hook) at `done` — gated on `memory.consolidation.enabled`, refusing cleanly without a provider (no silent paid calls, per the platform invariant). This makes "checkpoint auto-updates agent-memory" true for the document phase.

## Non-goals

- **The engine never executes commands.** No `child_process` in `packages/workflow/src` — execution stays in the CLI (user-invoked `noir task verify`) and the host agent. This is a hard boundary (research: engine owns contract, host owns shell; also keeps the daemon's single-writer, local-first posture).
- **No new FSM state in this spec.** `blocked` stays the recovery terminal (now reachable); the `awaiting-input` vs `errored` split of `blocked` (fsm-orchestration research) is a documented v2.0 refinement per ADR-0006, not shipped here.
- **No full lifecycle-event audit rewrite.** Recording every transition (not just gates) is a separate, additive audit-widening decision tracked for C4 follow-up; this spec only extends the gate record with evidence.
- **No automation of the release pipeline itself** — see the release-phase spec. Publish-failure recovery here is limited to surfacing/blocking.
- **No auto-run of checks at gate time** — checks run on explicit `noir task verify` (or host invocation). Auto-running CI on every advance is out of scope (daemon-side polling is a v2 concern).
- **No per-gate evidence for spec/plan gates** — evidence applies to the verify gate only in this spec.

## Acceptance criteria

1. With `workflow.gate.verify.required: true` for a `feature` task and a configured check set: `noir task advance` into `done` with **no** evidence does not transition and reports `pendingGate: verify / evidence-required`; the audit has no new entry.
2. `noir task verify` (all checks green) then `noir task advance` → `done`, gate `approved` with `evidence` (checks, exit codes, digest, ranAt) in the audit.
3. A failing hard check: `noir task verify` exits 1; the audit records a `failed` decision with evidence; `noir task advance` does not land `done`; `noir task advance --force <reason>` records `forced` with the failed evidence attached and lands `done`; `noir task advance --skip` records `skipped`.
4. A failing soft check: advance proceeds to `approved` with the soft-fail flagged in the evidence `summary` (observable in audit).
5. Retry budget: after `retryBudget` failed verify runs on the same task without a pass, the CLI offers `noir task block "verify-failed: …"` as the default; the task becomes `blocked` with that `blockReason`; `noir task resume` surfaces it and re-running `noir task verify` is the first suggested next action.
6. A `cancel` from the artifact conflict seam during spec/plan write sets the task `blocked` with `artifact-conflict: <relPath>` (resumable).
7. On reaching `done` (with artifact wiring on), a decision stub + changelog entry are written via the conflict seam; `--no-artifacts` skips; memory consolidation fires only when `memory.consolidation.enabled` and a provider is configured.
8. **Backward compatible:** a task with no `verify` config behaves exactly as v1.9.4 — `advance` transitions and records `approved`/`forced`/`skipped` with no evidence and no blocking; all existing engine/daemon/CLI tests pass unchanged (grep-guard test asserts no `child_process` in workflow/src).
9. Full gate green: lint → build → typecheck → test → docs:validate.

## Testing strategy

- **Engine unit:** `advance` verify-gate evaluation — no-evidence → pendingGate (no transition, no audit entry); evidence-pass → approved; evidence-fail → `failed` recorded + no transition; `force`/`skip` escapes; backward-compat path (no config → old behavior); stale-evidence (`ranAt < updatedAt`) treated as "no evidence". Evidence shape validation (a `failed` decision requires evidence).
- **Config:** `WorkflowGateConfig.verify` default-off; `NoirConfig` → engine bridge maps the `verify` slice; core↔workflow literal sync test.
- **CLI integration:** `noir task verify` resolves checks (config + detectStack defaults), runs them (sandboxed/offline — use a fixture script that fails/passes deterministically, **no real network**), builds evidence, submits via `workflow_advance`; recovery render paths (retry/force/skip/block).
- **Document-phase wiring:** fixture task reaching `done` writes decision/changelog stubs through the conflict seam; `--no-artifacts` skips; memory hook respects the provider gate (no provider → clean refusal).
- **Docs:** `docs/explanation/sdd-workflow.md` gains a Verify & recovery section; `docs/reference/cli-auto.md` gains `noir task verify`; capability-04 acceptance criterion #6 status updated.

## Rollback

- **Strictly additive until configured.** The only behavior change is under `verify.required` (default off) — a config the repo does not set today, so no existing task changes behavior. Rollback = remove the `verify` config block + revert the widened `GateResult`/`AdvanceOpts` fields (the old 3-decision enum is a subset; the wider union is backward-compatible but reverts cleanly).
- **Evidence records:** new audit entries (`failed`) appear only when verification is configured — a greenfield concern. `force`/`skip` semantics are unchanged.
- **Document-phase wiring:** behind the `done` transition + `--no-artifacts` escape; a decision/changelog stub written in error is removable via the conflict seam (`rename` moves it to `<abs>.local`), and the stubs are append-only/marked pending.
- **Migration:** none — no store schema change; audit entries widen in place (existing entries have no `evidence` field and remain valid).

## References

- `packages/workflow/src/engine.ts` — `advance`, `setBlocked`, `checkpoint`
- `packages/workflow/src/gates.ts` — `recordGate`, `readGateHistory`
- `packages/workflow/src/types.ts` — `GateResult`/`GateResultInput`, `WorkflowGateConfig`, `TASK_CLASSES`
- `packages/workflow/src/artifacts.ts` — `writeDecisionStub`, `writeChangelogStub`, conflict seam (`resolveAndWrite`)
- `packages/daemon/src/server.ts` — `workflow_advance` (L349-400), degraded envelopes
- `packages/cli/src/commands/task.ts` — `taskAdvance`, `PHASE_SKILL`; new `noir task verify`
- `packages/create/src/stack-detect.ts` — detected-stack check defaults
- `packages/memory/src/consolidate.ts` — provider-gated consolidation hook
- `packages/skills/builtin/noir-verifying/SKILL.md` — becomes gate-connected
- Docs to sync: `docs/explanation/sdd-workflow.md`, `docs/reference/cli-auto.md`, `docs/roadmap/capability-04-ai-development-workflow.md`, `docs/roadmap/backlog.md`
