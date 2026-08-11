# C4 Surface Wiring — resume, taskClass/PRD gate, quick mode, blocked/abandon, config bridge (spec)

> Capability-04 (End-to-End AI Development Workflow) delta — the **most material** finding of the 2026-08-11 audit: several spec-mandated engine features (ADR-0003 slice P, v1x §4.1, s4 §6) are **fully implemented in `@noir-ai/workflow` but unreachable from every user surface**. `resumeTask` has zero callers; `taskClass` is not plumbed so the soft PRD gate can never fire; `runQuick` is never invoked so `--mode quick` is a non-functional fast-forward; `setBlocked`/`abandon` are engine-only; and the `prd.mandatoryFor` config bridge is declared but not wired. This spec activates all of them — **purely additive, zero FSM change**.
>
> Internal docs follow `docs/internal/specs/` (no `.superpowers/`). Research basis: resume-UX patterns (Codex `--resume`, Aider `--continue`, Claude Code session resume, git-status-style snapshots) and taskClass-gated right-sizing (spec-driven-dev findings).

## Goal

Make every already-shipped workflow-engine capability **reachable and exercisable** from the CLI + MCP surface, with no FSM or engine-contract change:

1. **`noir task resume`** — a user can discover and continue an in-flight/blocked task across sessions (today `resumeTask` is library-only).
2. **`taskClass` plumbing** — `workflow_start` accepts `taskClass`; `noir task new --class <taskClass>` sets it, so the soft PRD gate for `feature`/`epic` actually fires and `--force` becomes the real override path.
3. **Quick mode made real** — `workflow_start mode:'quick'` / `noir task new --mode quick` invoke `runQuick` (stub spec + skipped spec/plan gates + fast-forward to executing).
4. **`blocked`/`abandon` surface** — users can mark a task blocked (with reason) or abandoned; a blocked task is resumable via the existing FSM edges.
5. **`prd.mandatoryFor` config bridge** — `NoirConfig.prd.mandatoryFor` overrides reach the engine (currently both construction sites use the 3-arg default).

## Scope

### S1 — Plumb `taskClass` through `workflow_start` + `noir task new --class`

**Engine already accepts it** — `WorkflowEngine.startTask(taskId, slug, mode, taskClass?)` (`packages/workflow/src/engine.ts`), and `prdRecommendation` (`engine.ts`) already keys off `task.taskClass` vs `DEFAULT_GATE_CONFIG.prd.mandatoryFor`.

- **`packages/daemon/src/server.ts`** — widen the `workflow_start` input schema (`server.ts:323-327`) from `{ taskId, slug, mode }` to add `taskClass: z.enum(['feature','epic','enhancement','bugfix','spike','quick-task','refactor']).optional()`, and pass it through to `engine.startTask(taskId, slug, resolvedMode, taskClass)` (currently `server.ts:339` drops it).
- **`packages/cli/src/commands/task.ts`** — `TaskNewOptions` gains `class?: string` (flag `--class <taskClass>`); validate against `TASK_CLASSES` client-side (exit 2 on a typo, mirroring the mode validation at `task.ts:251-264`); pass `taskClass` in the `workflow_start` payload.
- **`packages/cli/src/commands/task.ts`** — `PHASE_SKILL` already maps phases → skills; `noir task status` should render the task's `taskClass` when present (so the PRD gate's applicability is visible).

**Config bridge (S5) must land with this** — without it, a user overriding `prd.mandatoryFor: ['epic']` still gets the engine default. See S5.

### S2 — `noir task resume` + `workflow_resume` MCP tool

**Engine already has it** — `resumeTask(store)` (`packages/workflow/src/modes.ts:71-80`) reads `workflow:active` → the persisted TaskState, returns `null` for terminal (`done`/`abandoned`), returns the task for `blocked` and any in-flight state. Uses only the public `Store` API (no live engine).

- **`packages/daemon/src/server.ts`** — register `workflow_resume`:
  - input: `{ taskId?: string }` (optional; defaults to the active task via `engine.activeTaskId()` — same defaulting as `workflow_advance` at `server.ts:386`).
  - behavior: `const task = taskId ? engine.status(taskId) : await resumeTask(store)`; if `null`/terminal → `{ ok: true, resumable: false, error: 'no resumable task' }`; else → reuse `buildWorkflowStatus` + add a `nextAction` object: `{ nextPhase, nextState, gate: gateFor(nextPhase), skill: <PHASE_SKILL entry>, artifactPaths: [spec.md, plan.md, task.md as present] }`. The `nextAction` is derived CLI-side in the command (the daemon stays a thin engine wrapper); keep the tool returning `buildWorkflowStatus` payload + a `resumable: boolean`.
  - degraded (read-only store): resume is a read — allow it (mirrors `workflow_status`).
- **`packages/cli/src/commands/task.ts`** — new `noir task resume` command:
  - `noir task resume` (no arg) → calls `workflow_resume`, renders a **resume briefing**: state, phase, `blockReason` if blocked, next phase + gate + skill hint, and the artifact paths. Exit 0 when resumable, exit 1 ("nothing to resume") when terminal/none.
  - `noir task resume --last` → same but explicitly targets the active task (for scripting).
  - `noir task resume <taskId>` → targets that task (non-terminal check).
  - `--prompt '<continue instruction>'` → records a `resume:<taskId>` KV entry `{ prompt, at }` (append-only, observable — mirrors the gate-audit invariant) so the host can see the resume intent; no FSM state change.
  - Add the command to the commander tree (`bin.ts`) and surface it in `noir task --help` + the home-menu sections if applicable.
- **`noir status`** (`packages/cli/src/commands/status.ts`) — when a resumable task exists, print a one-line hint `resume: noir task resume` (git-status-style "next action").

### S3 — Wire quick mode (`runQuick`)

**Engine already has it** — `runQuick(engine, taskId, opts?)` (`packages/workflow/src/modes.ts:37-54`) writes the stub spec and fast-forwards draft→executing with spec+plan gates recorded `skipped`. Currently **zero callers**.

- **`packages/daemon/src/server.ts`** — in the `workflow_start` handler (`server.ts:329-346`): when `resolvedMode === 'quick'`, after `engine.startTask(..., 'quick')` call `await runQuick(engine, taskId)` (import from `@noir-ai/workflow`). The stub spec then lands at `.noir/specs/<taskId>-<slug>.md` and the gates are recorded `skipped`.
- **`packages/cli/src/commands/task.ts`** — `noir task new --mode quick` already sends `mode:'quick'`; no CLI change needed beyond S1's `--class`. Confirm `--mode quick` now results in the stub spec + skipped gates via an integration test.

### S4 — Surface `setBlocked` / `abandon`

**Engine already has both** — `WorkflowEngine.setBlocked(taskId, reason?)` (`engine.ts:314-327`, rejects whitespace-only reason) and `abandon(taskId)` (`engine.ts:330-336`, terminal). Both are currently unreachable (grep: no refs in daemon/cli).

- **`packages/daemon/src/server.ts`** — register two small tools:
  - `workflow_block`: input `{ taskId?: string, reason: string }` (reason min 1, matches the engine's non-empty validation). Calls `engine.setBlocked(id, reason)`, returns `buildWorkflowStatus`. Degraded → read-only envelope (write).
  - `workflow_abandon`: input `{ taskId?: string }`. Calls `engine.abandon(id)`, returns status. Degraded → read-only envelope.
- **`packages/cli/src/commands/task.ts`** — `noir task block <reason>` and `noir task abandon` (both target the active task when no id given; `--task <id>` to disambiguate). `abandon` should prompt-confirm in interactive mode (destructive — a task record is terminal), matching the existing in-TUI destructive-confirm pattern.
- Recovery story becomes real: `blocked` retains FSM edges to every in-flight phase (`state-machine.ts:18-19`), so `noir task advance --to <phase>` resumes from a blocked task; `workflow_resume` (S2) surfaces exactly that.

### S5 — `prd.mandatoryFor` config bridge

**Engine already documents the contract** — `WorkflowGateConfig` (`types.ts:100-116`) and `DEFAULT_GATE_CONFIG` (`engine.ts:33-35`); the constructor's 4th `gateConfig` param is optional. But **no construction site passes it**: `buildWorkflowEngine` (`workflow-seam.ts:25`) and the CLI in-process read fallback (`daemon-client.ts:456`) both use the 3-arg shape.

- **`packages/daemon/src/workflow-seam.ts`** — `buildWorkflowEngine(store, root, projectId, gateConfig?)`; accept an optional `WorkflowGateConfig` and pass it to `new WorkflowEngine(store, root, projectId, gateConfig)`. The seam now carries the bridge (engine stays core-cycle-free: `core`'s `prd` schema and `workflow`'s `WorkflowGateConfig` stay duplicated literals in sync by tests, exactly as `types.ts` documents).
- **`packages/daemon/src/server.ts`** — when constructing the engine, resolve the gate config from the project's `NoirConfig` (`cfg.prd.mandatoryFor` → `{ prd: { mandatoryFor } }`), defaulting to `DEFAULT_GATE_CONFIG` when absent. Mirror the existing config-loading used for `memory`/`model` (provider-explicit, never env-inferred).
- **`packages/cli/src/daemon-client.ts`** — the in-process read-only fallback construction site (`daemon-client.ts:456`) also passes the resolved gate config so degraded reads match the daemon path.
- **`packages/core/src/config.ts`** — no schema change (the `prd` block already exists at `config.ts:178-186`); this is wiring only. Add a sync test asserting the `core` `z.enum` literal and `workflow` `TASK_CLASSES` stay identical (the existing comment's "kept in sync by tests" must be made true).

## Non-goals

- **No FSM change** — no new states, no new transitions, no new gates. `blocked`/`abandoned`/`jump` semantics are untouched.
- **No new audit contract** — the resume prompt record (`resume:<taskId>`) is additive KV, not part of `GateResult`/`TaskState.history`. Full lifecycle-event auditing is a separate spec (`2026-08-11-c4-verify-gate-recovery-design.md`).
- **No `taskClass` for `workflow_advance`** — a class is fixed at task creation; changing it mid-flight is out of scope.
- **No cross-project resume widening** — resume is project-scoped (ProjectId-keyed store), matching v1 one-task-per-project semantics. (Claude-style Ctrl+A widening is a v2 concern per ADR-0006.)
- **No `noir task resume` transcript replay / host-session re-attach** — Noir is host-agnostic and cannot restore host-internal state; resume is a **briefing + next-action** surface. (Research finding: transcripts must never be required for resume.)

## Acceptance criteria

1. `noir task new --slug <s> --class feature` → `workflow_status` / `noir task status` shows `taskClass: feature`; `--class bogus` exits 2.
2. With `prd.mandatoryFor` containing the task's class and no `.noir/prd/<id>-<slug>.md`, entering the spec gate via `noir task advance` records the PRD recommendation note on the spec gate (observable in audit); `--force <reason>` records `forced` with the reason; a non-mandatory class records no note. **(This is the previously-dead soft PRD gate, now live end-to-end.)**
3. Overriding `prd.mandatoryFor: ['epic']` in `noir.config` (or equivalent) makes `feature` tasks NOT trigger the recommendation — proving the config bridge works in both daemon and in-process-read paths.
4. `noir task new --mode quick` → stub spec at `.noir/specs/<id>-<slug>.md`, spec+plan gates recorded `skipped` in the audit, task lands at `executing`; verify gate still fires `approved` on `done`.
5. `noir task block <reason>` sets the active task to `blocked` with `blockReason`; `noir task status` shows it; `noir task advance --to <phase>` resumes it (jumpEntry recorded); `noir task abandon` (confirmed) makes it terminal.
6. `noir task resume` on an active non-terminal task prints a briefing (state, phase, next action + skill hint, artifact paths) and exits 0; on a `done`/`abandoned`/none task prints "nothing to resume" and exits 1; `noir task resume --last --prompt 'continue X'` writes the resume KV record.
7. `noir status` shows the `resume: noir task resume` hint when a resumable task exists.
8. Full gate green: lint → build → typecheck → test → docs:validate (test count grows; the audit-KV/engine contract tests must stay unchanged).
9. Backward compatible: existing calls without `taskClass` / with `mode` omitted behave exactly as before (byte-identical for a bare `noir task new --slug`).

## Testing strategy

- **Unit (engine, unchanged contracts):** add tests that `prdRecommendation` fires when `taskClass` is set and `mandatoryFor` matches — exercising the previously-dead branch via the engine directly (these branches exist but are untested through the surface).
- **Daemon/CLI integration:** drive `workflow_start` with `taskClass`, `mode:'quick'`, `workflow_resume`, `workflow_block`, `workflow_abandon` over the MCP client harness; assert wire shapes. Follow the existing cassette/mock patterns — **no real network** (test suite is offline/free).
- **Config bridge:** unit-test `buildWorkflowEngine(store, root, projectId, gateConfig)` propagates overrides; a core↔workflow literal-sync test.
- **Docs:** update `docs/explanation/sdd-workflow.md` (remove the two ⚠️ surface-caveats added in the 2026-08-11 accuracy pass), `docs/reference/cli-auto.md` (new commands), and capability-04 "Shipped today" (mark wired).

## Rollback

- **Every change is additive** — a new optional MCP input, new CLI subcommands, an optional constructor arg, and one behavior change (quick mode now fast-forwards). The single behavior change is behind the existing `mode:'quick'` flag, which today is a documented-but-inert no-op; enabling it cannot regress existing full-mode flows.
- **Rollback:** revert the `workflow_start` handler's `runQuick` call and the optional schema/arg additions; every pre-existing test must pass without modification (the audit-KV and engine tests are untouched).
- **Migration:** none — no schema change to the store, no KV layout change (the `resume:<taskId>` KV entry is a new additive key).
- If quick-mode wiring surfaces any daemon ordering bug (startTask → runQuick), the safe fallback is: keep `workflow_start` schema + config bridge, ship resume/block/abandon, and gate quick-mode wiring behind a follow-up — but the spec expects all five to land together, with `runQuick` error paths surfaced as a clean JSON error (mirroring the degraded envelope) rather than a crash.

## References

- `packages/workflow/src/engine.ts` — `startTask` (taskClass 4th arg), `prdRecommendation`, `setBlocked`, `abandon`, `checkpoint`
- `packages/workflow/src/modes.ts` — `runQuick`, `resumeTask`, `QUICK_SPEC_STUB`
- `packages/workflow/src/types.ts` — `TASK_CLASSES`, `WorkflowGateConfig`
- `packages/daemon/src/server.ts` — `workflow_start` (L318-347), `workflow_advance` (L349-400), degraded envelopes
- `packages/daemon/src/workflow-seam.ts` — `buildWorkflowEngine` (L25, 3-arg today)
- `packages/cli/src/commands/task.ts` — `taskNew` (L245+), `taskAdvance`, `PHASE_SKILL`, mode validation
- `packages/cli/src/daemon-client.ts` — in-process read fallback construction site (L456)
- `packages/core/src/config.ts` — `prd` block (L178-186)
- Docs to sync: `docs/explanation/sdd-workflow.md`, `docs/reference/cli-auto.md`, `docs/roadmap/capability-04-ai-development-workflow.md`
