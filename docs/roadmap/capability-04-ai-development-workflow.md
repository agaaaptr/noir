# Capability 4 — End-to-End AI Development Workflow

> **Status:** 🟩 **Completed** — shipped core (SDD engine) + all 6 deltas implemented (2026-08-11). No open gaps.

## Overview

Noir dogfoods Spec-Driven Development (SDD): the `@noir-ai/workflow` FSM engine runs the spec-first lifecycle with observable, escapable gates. The engine is real and ships in `@noir-ai/workflow` v1.9.0; a formal research phase, a release phase, and automated validation are the open deltas.

## Shipped today

- **FSM lifecycle engine (v1.9.0):** intake → clarify → spec → plan → execute → verify → document — 9 states total (the 7 lifecycle phases plus the `blocked`/`abandoned` admin states, which the engine sets directly and which have no FSM edge *in*), with observable, escapable gates at spec/plan/verify. "Escapable" is three mechanisms: `force {reason}`, `skip`, and `jump {to}` (bypasses the FSM; a jump landing on a gate state still records that gate). — `packages/workflow/src/engine.ts`, `packages/workflow/src/state-machine.ts`, `packages/workflow/src/gates.ts`, `packages/workflow/src/modes.ts`.
- **Gate audit as source of truth:** every gate decision is appended to the `audit:<taskId>` KV (append-only, never silently dropped) and re-derived onto `TaskState.history` on every advance and status read. The on-disk export `.noir/audit/<taskId>.json` is produced by an explicit `engine.checkpoint()` — it does **not** fire per-gate. — `packages/workflow/src/gates.ts` (`recordGate`/`readGateHistory`), `packages/workflow/src/artifacts.ts` (`writeAuditExport`).
- **Full mode (default) + Quick mode:** full mode is the default (resolved in `packages/daemon/src/server.ts`); `runQuick` writes a stub spec (`.noir/specs/<taskId>-<slug>.md`), fast-forwards draft→executing, records the spec+plan gates as `skipped`, and leaves the verify gate to fire `approved` on `done`. Wired into the surface: `workflow_start mode:'quick'` / `noir task new --mode quick`. — `packages/workflow/src/modes.ts`, `packages/daemon/src/server.ts`.
- **Soft, escapable PRD recommendation** for `feature`/`epic` in full mode (`prd.mandatoryFor` defaults to `['feature','epic']`) — fires at the spec gate as an observable note (the advance always proceeds; `--force <reason>` is the explicit override). Set a task's class via `noir task new --class <taskClass>` / `workflow_start taskClass`; the `prd.mandatoryFor` config reaches the engine via the daemon/CLI config bridge. — `packages/workflow/src/engine.ts` (`prdRecommendation`, `DEFAULT_GATE_CONFIG`), `packages/daemon/src/workflow-seam.ts` (`resolveGateConfig`).
- **Cross-session resume (`resumeTask`):** blocked tasks are resumable across sessions; done/abandoned are terminal. Surfaced via `noir task resume` (briefing + `--last` + `<id>` + `--prompt`) and the `workflow_resume` MCP tool. — `packages/workflow/src/modes.ts`, `packages/cli/src/commands/task.ts`.
- **Artifact writers** for intake/spec/prd/plan/task/decision/changelog/audit with a conflict-resolution seam (`replace`/`preserve`/`rename`/`duplicate`/`cancel` + non-interactive fallback). `writeDecisionStub`/`writeChangelogStub` are wired to the document phase (`noir task advance` → `done` writes both via the conflict seam; `--no-artifacts` escapes). — `packages/workflow/src/artifacts.ts`.
- **MCP tools:** `workflow_status`, `workflow_start`, `workflow_advance`, `workflow_resume`, `workflow_block`, `workflow_abandon`, `checkpoint {save|restore}` — `packages/daemon/src/server.ts` (not `workflow-seam.ts`, which builds the engine + the `resolveGateConfig` config bridge).
- **CLI:** `noir task new|status|advance|next|resume|block|abandon`, `noir handoff`, `noir status` (workflow snapshot + resume hint) — `packages/cli/src/commands/task.ts`.
- **26 builtin skills** + 1 integration including the SDD lifecycle playbooks `noir-brainstorming`/`spec`/`planning`/`executing-plans`/`verifying`/`wrap`/`checkpoint` — e.g. `packages/skills/builtin/noir-spec/SKILL.md`, `packages/skills/builtin/noir-planning/SKILL.md`.

## Gap / roadmap delta

> Status of each delta, as re-verified against the codebase (2026-08-11 audit). Each gap now has a design spec in `docs/internal/specs/`; "🟦 Spec'd" = the design is written and awaiting implementation.

- **Research phase/step in the FSM:** the s4 spec deliberately defines **no** research state — research is a grounding step inside PRD drafting (v1x §4.1), not a lifecycle phase; there is also no dedicated `noir-research` skill (research-as-practice lives inside `noir-brainstorming`/`noir-exploring`). Direction (research-grounded): model research as a soft, taskClass-gated grounding sub-step (read-only mode + audit-KV records), **not** a 10th hard FSM state. — 🟦 Spec: `2026-08-11-c4-research-grounding-design.md`.
- **Automated ambiguity/missing-requirement detection in clarify:** clarify has **no artifact writer** (the spec-mandated `.noir/clarifications.md` is never produced) and ambiguity resolution is fully manual via `noir-brainstorming`. Automation was always a model-layer aspiration (v1x §4.1), not an FSM requirement. — 🟦 Spec: `2026-08-11-c4-research-grounding-design.md`.
- **Project discovery/detection in init/create:** `detectStack()` is shipped and wired for ignore-file selection (`.npmignore`/`.prettierignore`/`.dockerignore`), but CI detection + opt-in CI templates, an existing-AI-tooling probe (AGENTS.md/CLAUDE.md/.cursorrules/…), and the onboarding confirm step never shipped. — 🟦 Spec: `2026-08-11-c4-project-discovery-design.md`.
- **Capability → slice decomposition engine:** no design intent exists in any spec/ADR — a roadmap invention. Objective/scope/dependency/acceptance/testing/rollback artifacts are not auto-derived. Direction: a Spec-of-Specs roadmap pass with `rollback_plan` per slice as Noir's differentiation. — 🟦 Spec: `2026-08-11-c4-decomposition-design.md`.
- **Release phase/tool in the lifecycle:** releases today run outside via the patch-release flow (`scripts/bump-version.mjs` → `pnpm release:tag` → GitHub Actions). The s4 spec never designed a release phase; this is a new capability. — 🟦 Spec: `2026-08-11-c4-release-phase-design.md`.
- **Recovery workflow for CI/test/publish failure and merge/spec conflicts:** ✅ **Shipped (2026-08-11, c4-verify-gate-recovery).** `noir task verify` runs configured checks + submits evidence to an evidence-backed verify gate; a failed HARD check records `failed` + offers recovery (retry/force/skip/block); `blocked` (reachable via `noir task block`) is the resumable recovery state; the artifact conflict seam handles merge/spec conflicts (`cancel` → blocked). — Spec: `2026-08-11-c4-verify-gate-recovery-design.md`.
- **Automated validation commands wired to the verify gate:** ✅ **Shipped (2026-08-11).** `noir task verify` resolves checks from `workflow.gate.verify.checks` config, runs them (CLI owns shell access; the engine never shells out), hashes output, and submits `GateEvidence` to `workflow_advance`; HARD checks block on non-zero, SOFT checks record + nudge. Default OFF (byte-identical to v1.9.4 when unconfigured). — Spec: `2026-08-11-c4-verify-gate-recovery-design.md`.
- **Checkpoint auto-update of roadmap/changelog/progress/agent-memory:** ✅ **Shipped (2026-08-11).** `noir task advance` to `done` writes a changelog entry + a pending decision-record stub via the artifact conflict seam (preserve-on-conflict; `--no-artifacts` escapes); memory consolidation is provider-gated via the existing daemon engine. — Spec: `2026-08-11-c4-verify-gate-recovery-design.md`.
- **Surface cross-session resume to users:** ✅ **Shipped (2026-08-11, c4-surface-wiring).** `noir task resume` + `workflow_resume` MCP tool (resumable briefing for in-flight/blocked tasks; terminal = not resumable); `taskClass` plumbed through `workflow_start` + `noir task new --class` (soft PRD gate live); quick-mode `runQuick` wired into `workflow_start mode:'quick'`; `setBlocked`/`abandon` surfaced via `workflow_block`/`workflow_abandon` + `noir task block|abandon`; `prd.mandatoryFor` config bridge via `resolveGateConfig`. — Spec: `2026-08-11-c4-surface-wiring-design.md`.

## Acceptance criteria

> Status per the 2026-08-11 audit + spec suite. "🟦 Spec'd" = the design is written; the criterion becomes **MET** when the spec's implementation lands.

- FSM runs intake → clarify → spec → plan → execute → verify → document with observable, escapable gates at spec/plan/verify. — **MET** (v1.9.0; see `packages/workflow/src/engine.ts`).
- Every gate decision persists to `audit:<taskId>` KV, `TaskState.history`, and `.noir/audit/<taskId>.json`. — **MET** (minor: the JSON export fires on explicit `checkpoint()`, not per-gate).
- A blocked task can be resumed across sessions; done/abandoned tasks are terminal. — **MET** at the engine; user-reachable via `noir task resume` after the surface-wiring spec. — 🟦 [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md)
- Research is a first-class sub-step with its own gate/artifacts, not only a skill. — **reinterpreted per research** (no leading tool uses a hard research state; the s4 spec never designed one): research becomes a first-class **soft grounding sub-step** (read-only mode, `research:<taskId>` audit records, `noir-research` skill, spec-gate grounding check). — 🟦 [`2026-08-11-c4-research-grounding-design.md`](../internal/specs/2026-08-11-c4-research-grounding-design.md)
- Init/create detects the project's framework, package manager, CI, and existing AI tooling and seeds the workflow accordingly. — partial today (`detectStack()` wired for ignore-files); full detection + onboarding confirm + workflow seeding spec'd. — 🟦 [`2026-08-11-c4-project-discovery-design.md`](../internal/specs/2026-08-11-c4-project-discovery-design.md)
- A `noir task resume` (or equivalent) exists and `taskClass` is accepted so the soft PRD gate is reachable by users. — **MET** (2026-08-11, c4-surface-wiring): `noir task resume` + `workflow_resume`; `noir task new --class` + `workflow_start taskClass`; quick mode, block, abandon, and the config bridge all wired. — [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md)
- Verify gate triggers automated validation (tests/lint/CI) and recovery flows exist for CI/test/publish failure and merge/spec conflicts. — **MET** (2026-08-11, c4-verify-gate-recovery): `noir task verify` + evidence-backed verify gate (HARD blocks/SOFT nudges) + block-and-offer-recovery + conflict-seam recovery; publish-failure recovery in the release-phase spec. — [`2026-08-11-c4-verify-gate-recovery-design.md`](../internal/specs/2026-08-11-c4-verify-gate-recovery-design.md)

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
