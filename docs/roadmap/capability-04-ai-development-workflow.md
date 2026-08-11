# Capability 4 — End-to-End AI Development Workflow

> **Status:** Shipped core (SDD engine) — **all deltas fully specified** (2026-08-11 spec suite); implementation pending. No open design gaps remain.

## Overview

Noir dogfoods Spec-Driven Development (SDD): the `@noir-ai/workflow` FSM engine runs the spec-first lifecycle with observable, escapable gates. The engine is real and ships in `@noir-ai/workflow` v1.9.0; a formal research phase, a release phase, and automated validation are the open deltas.

## Shipped today

- **FSM lifecycle engine (v1.9.0):** intake → clarify → spec → plan → execute → verify → document — 9 states total (the 7 lifecycle phases plus the `blocked`/`abandoned` admin states, which the engine sets directly and which have no FSM edge *in*), with observable, escapable gates at spec/plan/verify. "Escapable" is three mechanisms: `force {reason}`, `skip`, and `jump {to}` (bypasses the FSM; a jump landing on a gate state still records that gate). — `packages/workflow/src/engine.ts`, `packages/workflow/src/state-machine.ts`, `packages/workflow/src/gates.ts`, `packages/workflow/src/modes.ts`.
- **Gate audit as source of truth:** every gate decision is appended to the `audit:<taskId>` KV (append-only, never silently dropped) and re-derived onto `TaskState.history` on every advance and status read. The on-disk export `.noir/audit/<taskId>.json` is produced by an explicit `engine.checkpoint()` — it does **not** fire per-gate. — `packages/workflow/src/gates.ts` (`recordGate`/`readGateHistory`), `packages/workflow/src/artifacts.ts` (`writeAuditExport`).
- **Full mode (default) + Quick mode:** full mode is the default (resolved in `packages/daemon/src/server.ts`); `runQuick` writes a stub spec (`.noir/specs/<taskId>-<slug>.md`), fast-forwards draft→executing, records the spec+plan gates as `skipped`, and leaves the verify gate to fire `approved` on `done`. ⚠️ Not yet wired into the public surface — `workflow_start mode:'quick'` / `noir task new --mode quick` currently start the task without the quick fast-forward (see the surface-wiring spec). — `packages/workflow/src/modes.ts`.
- **Soft, escapable PRD recommendation** for `feature`/`epic` in full mode (`prd.mandatoryFor` defaults to `['feature','epic']`) — fires at the spec gate as an observable note (the advance always proceeds; `--force <reason>` is the explicit override). ⚠️ The config bridge (NoirConfig `prd.mandatoryFor` → engine) is not implemented and `taskClass` is not plumbed through `workflow_start`/`noir task new`, so the recommendation is currently unreachable from the public surface (see the surface-wiring spec). — `packages/workflow/src/engine.ts` (`prdRecommendation`, `DEFAULT_GATE_CONFIG`).
- **Cross-session resume (`resumeTask`):** blocked tasks are resumable across sessions; done/abandoned are terminal. ⚠️ Currently library-only — no `noir task resume` command (see the surface-wiring spec). — `packages/workflow/src/modes.ts`.
- **Artifact writers** for intake/spec/prd/plan/task/decision/changelog/audit with a conflict-resolution seam (`replace`/`preserve`/`rename`/`duplicate`/`cancel` + non-interactive fallback). ⚠️ `writeDecisionStub`/`writeChangelogStub` are exported but have no callers (dead API pending the document-phase wiring). — `packages/workflow/src/artifacts.ts`.
- **MCP tools:** `workflow_status`, `workflow_start`, `workflow_advance`, `checkpoint {save|restore}` — `packages/daemon/src/server.ts` (not `workflow-seam.ts`, which only builds the engine).
- **CLI:** `noir task new|status|advance|next`, `noir handoff`, `noir status` (workflow snapshot) — `packages/cli/src/commands/task.ts`.
- **26 builtin skills** + 1 integration including the SDD lifecycle playbooks `noir-brainstorming`/`spec`/`planning`/`executing-plans`/`verifying`/`wrap`/`checkpoint` — e.g. `packages/skills/builtin/noir-spec/SKILL.md`, `packages/skills/builtin/noir-planning/SKILL.md`.

## Gap / roadmap delta

> Status of each delta, as re-verified against the codebase (2026-08-11 audit). Each gap now has a design spec in `docs/internal/specs/`; "🟦 Spec'd" = the design is written and awaiting implementation.

- **Research phase/step in the FSM:** the s4 spec deliberately defines **no** research state — research is a grounding step inside PRD drafting (v1x §4.1), not a lifecycle phase; there is also no dedicated `noir-research` skill (research-as-practice lives inside `noir-brainstorming`/`noir-exploring`). Direction (research-grounded): model research as a soft, taskClass-gated grounding sub-step (read-only mode + audit-KV records), **not** a 10th hard FSM state. — 🟦 Spec: `2026-08-11-c4-research-grounding-design.md`.
- **Automated ambiguity/missing-requirement detection in clarify:** clarify has **no artifact writer** (the spec-mandated `.noir/clarifications.md` is never produced) and ambiguity resolution is fully manual via `noir-brainstorming`. Automation was always a model-layer aspiration (v1x §4.1), not an FSM requirement. — 🟦 Spec: `2026-08-11-c4-research-grounding-design.md`.
- **Project discovery/detection in init/create:** `detectStack()` is shipped and wired for ignore-file selection (`.npmignore`/`.prettierignore`/`.dockerignore`), but CI detection + opt-in CI templates, an existing-AI-tooling probe (AGENTS.md/CLAUDE.md/.cursorrules/…), and the onboarding confirm step never shipped. — 🟦 Spec: `2026-08-11-c4-project-discovery-design.md`.
- **Capability → slice decomposition engine:** no design intent exists in any spec/ADR — a roadmap invention. Objective/scope/dependency/acceptance/testing/rollback artifacts are not auto-derived. Direction: a Spec-of-Specs roadmap pass with `rollback_plan` per slice as Noir's differentiation. — 🟦 Spec: `2026-08-11-c4-decomposition-design.md`.
- **Release phase/tool in the lifecycle:** releases today run outside via the patch-release flow (`scripts/bump-version.mjs` → `pnpm release:tag` → GitHub Actions). The s4 spec never designed a release phase; this is a new capability. — 🟦 Spec: `2026-08-11-c4-release-phase-design.md`.
- **Recovery workflow for CI/test/publish failure and merge/spec conflicts:** only `blocked`/`abandon`/`jump` exist — and `setBlocked`/`abandon` are engine-only (unreachable from CLI/MCP). Recovery flows were never specified. — 🟦 Spec: `2026-08-11-c4-verify-gate-recovery-design.md`.
- **Automated validation commands wired to the verify gate:** `noir-verifying` is a generic host-side evidence skill, not gate-connected; the engine runs no external commands (gates record a decision only). — 🟦 Spec: `2026-08-11-c4-verify-gate-recovery-design.md`.
- **Checkpoint auto-update of roadmap/changelog/progress/agent-memory:** `engine.checkpoint` only flushes KV + audit JSON; `writeDecisionStub`/`writeChangelogStub` are dead API (built but never wired to the document phase). — 🟦 Spec: `2026-08-11-c4-verify-gate-recovery-design.md` + `2026-08-11-c4-decomposition-design.md`.
- **Surface cross-session resume to users:** no `noir task resume` command; `workflow_start` / `noir task new` don't accept `taskClass`, so the soft PRD gate is effectively dead. This is the **most material** delta — spec-mandated (ADR-0003 slice P, v1x §4.1, s4 §6), fully implemented in the engine, purely additive to wire. — 🟦 Spec: `2026-08-11-c4-surface-wiring-design.md`.

## Acceptance criteria

> Status per the 2026-08-11 audit + spec suite. "🟦 Spec'd" = the design is written; the criterion becomes **MET** when the spec's implementation lands.

- FSM runs intake → clarify → spec → plan → execute → verify → document with observable, escapable gates at spec/plan/verify. — **MET** (v1.9.0; see `packages/workflow/src/engine.ts`).
- Every gate decision persists to `audit:<taskId>` KV, `TaskState.history`, and `.noir/audit/<taskId>.json`. — **MET** (minor: the JSON export fires on explicit `checkpoint()`, not per-gate).
- A blocked task can be resumed across sessions; done/abandoned tasks are terminal. — **MET** at the engine; user-reachable via `noir task resume` after the surface-wiring spec. — 🟦 [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md)
- Research is a first-class sub-step with its own gate/artifacts, not only a skill. — **reinterpreted per research** (no leading tool uses a hard research state; the s4 spec never designed one): research becomes a first-class **soft grounding sub-step** (read-only mode, `research:<taskId>` audit records, `noir-research` skill, spec-gate grounding check). — 🟦 [`2026-08-11-c4-research-grounding-design.md`](../internal/specs/2026-08-11-c4-research-grounding-design.md)
- Init/create detects the project's framework, package manager, CI, and existing AI tooling and seeds the workflow accordingly. — partial today (`detectStack()` wired for ignore-files); full detection + onboarding confirm + workflow seeding spec'd. — 🟦 [`2026-08-11-c4-project-discovery-design.md`](../internal/specs/2026-08-11-c4-project-discovery-design.md)
- A `noir task resume` (or equivalent) exists and `taskClass` is accepted so the soft PRD gate is reachable by users. — 🟦 spec'd (activates already-shipped engine features; zero FSM change). — [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md)
- Verify gate triggers automated validation (tests/lint/CI) and recovery flows exist for CI/test/publish failure and merge/spec conflicts. — 🟦 spec'd (evidence-backed gate, block-and-offer-recovery, conflict-seam recovery, publish-failure recovery). — [`2026-08-11-c4-verify-gate-recovery-design.md`](../internal/specs/2026-08-11-c4-verify-gate-recovery-design.md) + [`2026-08-11-c4-release-phase-design.md`](../internal/specs/2026-08-11-c4-release-phase-design.md)

## References

- `packages/workflow/src/engine.ts`
- `packages/workflow/src/state-machine.ts`
- `packages/workflow/src/gates.ts`
- `packages/daemon/src/workflow-seam.ts`
- `packages/cli/src/commands/task.ts`
- `docs/explanation/sdd-workflow.md`
- `packages/skills/builtin/noir-spec/SKILL.md`
- `packages/skills/builtin/noir-planning/SKILL.md`

## Design specs (2026-08-11 — full-lifecycle completion)

Every remaining gap now has a design spec in `docs/internal/specs/`. Each spec carries its own acceptance criteria, testing strategy, and rollback plan.

| Delta | Spec |
|---|---|
| Surface wiring — resume + `taskClass`/PRD gate + quick mode + blocked/abandon + config bridge (#9, most material) | [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md) |
| Verify-gate automation + evidence + recovery flows (#6/#7) | [`2026-08-11-c4-verify-gate-recovery-design.md`](../internal/specs/2026-08-11-c4-verify-gate-recovery-design.md) |
| Research soft-grounding + clarify ambiguity (#1/#2) | [`2026-08-11-c4-research-grounding-design.md`](../internal/specs/2026-08-11-c4-research-grounding-design.md) |
| Project discovery completion — CI + AI-tooling probe + onboarding confirm (#3) | [`2026-08-11-c4-project-discovery-design.md`](../internal/specs/2026-08-11-c4-project-discovery-design.md) |
| Capability → slice decomposition + `rollback_plan` (#4) | [`2026-08-11-c4-decomposition-design.md`](../internal/specs/2026-08-11-c4-decomposition-design.md) |
| Release phase/tool (#5) | [`2026-08-11-c4-release-phase-design.md`](../internal/specs/2026-08-11-c4-release-phase-design.md) |
