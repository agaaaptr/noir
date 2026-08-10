# Capability 4 — End-to-End AI Development Workflow

> **Status:** Shipped core — SDD engine; research/full-lifecycle phases are partial

## Overview

Noir dogfoods Spec-Driven Development (SDD): the `@noir-ai/workflow` FSM engine runs the spec-first lifecycle with observable, escapable gates. The engine is real and ships in `@noir-ai/workflow` v1.9.0; a formal research phase, a release phase, and automated validation are the open deltas.

## Shipped today

- **FSM lifecycle engine (v1.9.0):** intake → clarify → spec → plan → execute → verify → document, 9 states total, with observable, escapable gates at spec/plan/verify — `packages/workflow/src/engine.ts`, `packages/workflow/src/state-machine.ts`, `packages/workflow/src/gates.ts`.
- **Gate audit as source of truth:** every gate decision is appended to the `audit:<taskId>` KV, re-derived onto `TaskState.history`, and exported to `.noir/audit/<taskId>.json` — `packages/workflow/src/engine.ts`.
- **Full mode (default) + Quick mode:** Quick mode writes a stub spec, records gates as skipped, and still fires verify — `packages/workflow/src/engine.ts`.
- **Soft, escapable PRD recommendation** for feature/epic in full mode (`prd.mandatoryFor` defaults to `[feature, epic]`) — `packages/workflow/src/gates.ts`.
- **Cross-session resume (`resumeTask`):** blocked tasks are resumable; done/abandoned are terminal — `packages/workflow/src/engine.ts`.
- **Artifact writers** for intake/spec/prd/plan/task/decision/changelog/audit with a conflict-resolution seam — `packages/workflow/src/engine.ts`.
- **MCP tools:** `workflow_status`, `workflow_start`, `workflow_advance`, `checkpoint {save|restore}` — `packages/daemon/src/workflow-seam.ts`.
- **CLI:** `noir task new|status|advance|next`, `noir handoff`, `noir status` (workflow snapshot) — `packages/cli/src/commands/task.ts`.
- **26 builtin skills** + 1 integration including the SDD lifecycle playbooks `noir-brainstorming`/`spec`/`planning`/`executing-plans`/`verifying`/`wrap`/`checkpoint` — e.g. `packages/skills/builtin/noir-spec/SKILL.md`, `packages/skills/builtin/noir-planning/SKILL.md`.

## Gap / roadmap delta

- **Research phase/step in the FSM:** docs mandate research as a formal stage; today research exists only as a skill/practice, not a state.
- **Automated ambiguity/missing-requirement detection in clarify:** currently a manual `noir-brainstorming` step.
- **Project discovery/detection in init/create:** framework / package-manager / CI / existing-AI-tool detection is not wired in.
- **Capability → slice decomposition engine:** objective/scope/dependency/acceptance/testing/rollback artifacts are not auto-derived.
- **Release phase/tool in the lifecycle:** releases today run outside via release scripts.
- **Recovery workflow for CI/test/publish failure and merge/spec conflicts:** only blocked/abandoned/jump exist today.
- **Automated validation commands wired to the verify gate:** `noir-verifying` is a generic evidence skill, not gate-connected.
- **Checkpoint auto-update of roadmap/changelog/progress/agent-memory:** `engine.checkpoint` only flushes KV + audit JSON.
- **Surface cross-session resume to users:** no `noir task resume` command; `workflow_start` / `noir task new` don't accept `taskClass`, so the soft PRD gate is effectively dead.

## Acceptance criteria

- FSM runs intake → clarify → spec → plan → execute → verify → document with observable, escapable gates at spec/plan/verify. — **MET** (v1.9.0; see `packages/workflow/src/engine.ts`).
- Every gate decision persists to `audit:<taskId>` KV, `TaskState.history`, and `.noir/audit/<taskId>.json`. — **MET**.
- A blocked task can be resumed across sessions; done/abandoned tasks are terminal. — **MET**.
- Research is a first-class FSM state (with its own gate/artifacts), not only a skill. — done when a task's lifecycle can be `intake → research → clarify` and research produces persisted artifacts.
- Init/create detects the project's framework, package manager, CI, and existing AI tooling and seeds the workflow accordingly. — done when scaffolding consumes detection output.
- A `noir task resume` (or equivalent) exists and `taskClass` is accepted so the soft PRD gate is reachable by users. — done when the resume path is exercisable end-to-end.
- Verify gate triggers automated validation (tests/lint/CI) and recovery flows exist for CI/test/publish failure and merge/spec conflicts. — done when a failing validation blocks advance and a recovery path is offered.

## References

- `packages/workflow/src/engine.ts`
- `packages/workflow/src/state-machine.ts`
- `packages/workflow/src/gates.ts`
- `packages/daemon/src/workflow-seam.ts`
- `packages/cli/src/commands/task.ts`
- `docs/explanation/sdd-workflow.md`
- `packages/skills/builtin/noir-spec/SKILL.md`
- `packages/skills/builtin/noir-planning/SKILL.md`
