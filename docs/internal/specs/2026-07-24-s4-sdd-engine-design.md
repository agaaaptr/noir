# Noir — S4 SDD Workflow Engine Design

- **Date:** 2026-07-24
- **Status:** Reviewed (2026-07-24) — OQ-1…OQ-6 resolved (see §11); ready for implementation planning.
- **Owner:** agaaaptr
- **Spec type:** Implementation design (next slice after S1 Stores)
- **Parent:** `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (blueprint §6.1, §9.1) + the delivered walking-skeleton & S1 specs
- **Slice:** S4 (SDD Workflow Engine) — roadmap v1.0. Depends on `@noir-ai/core` + `@noir-ai/store` (S1).

---

## 0. TL;DR

The **opinionated-but-escapable Spec-Driven Development lifecycle** as a stateful engine — the Noir differentiator. A per-task **state machine** drives `Intake → Clarify → Spec → Plan → Execute → Verify → Document` through **programmatic, observable gates** (a quiet checkpoint, not rhetorical enforcement — blueprint §9.1). State persists in the **store KV** (S1) + **`.noir/` markdown artifacts**. Modes: **Full** (all gates), **Quick** (skip→execute, stubs a spec + runs verify), **Resume** (detect in-flight work). Gates are escapable via `--force` (logged); jump-to-any-phase is allowed (entry recorded).

S4 acceptance: ***the lifecycle runs end-to-end on a real task*** — a task progresses through the phases, gates record observable decisions, state survives across sessions (resume), and quick-mode + `--force` bypass both work.

**Grounded in 2026 SDD best practice:** GitHub Spec Kit + AWS Kiro put structured markdown specs in the codebase as the coordination artifact ([Spec Kit vs Kiro](https://codemyspec.com/blog/spec-kit-vs-kiro), [Martin Fowler](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html)). Noir does the same natively + host-agnostic, with **observable programmatic gates** (vs prompt-only rhetoric) per [approval-gate/audit-trail patterns](https://blog.brightcoding.dev/2025/12/30/framework-for-development-workflows-with-approval-steps-a-complete-safety-first-guide).

---

## 1. Goals & scope

### 1.1 In scope
- A per-task **state machine** + phase model (the lifecycle above) with explicit, inspectable transitions.
- **Observable gates** (Spec, Plan, Verify) — a programmatic checkpoint that records the decision (approved / bypassed-via-force / skipped-quick) to an audit record; never rhetorical.
- **Modes:** Full (default), Quick (`--quick`: skip→execute, stub spec, still run verify), Resume (detect in-flight from store state).
- **Escapability:** `--force` bypasses a gate (logged with reason); jump-to-any-phase (entry point recorded).
- **Persistence:** machine state in the store KV (S1); human-readable artifacts under `.noir/` (`intake.md`, `clarifications.md`, `specs/<id>-<slug>.md`, `plans/<id>.md`, `tasks/<id>/*`, `decisions/`, `audit/`).
- **MCP surface (minimal):** `noir.checkpoint` (save/restore workflow state for resume) + `noir.workflow_status` (current task/phase/gate). *(Full authoring tools — spec/plan/task drafting — see OQ-2.)*
- Tests: state-machine transitions (legal/illegal), gate recording, modes, resume across a re-opened store, `--force` audit.

### 1.2 Out of scope (later slices)
- **Spec/plan/task DRAFTING** by an LLM (the bounded model layer **S8**) — S4 provides the *lifecycle + scaffolding*, not the model that drafts artifacts.
- **Context/memory integration** (S6/S7) — the engine reads/writes the store's KV, but context retrieval + memory recall are separate slices.
- **The TUI home screen** (S9) — S4 is an engine + MCP surface, headless.
- **Cross-task orchestration / parallel tasks** — one active task per project in v1.

---

## 2. Decisions (drafted; confirm at review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Engine location | **New package `@noir-ai/workflow`** (6th; depends `core` + `store`) | Keeps `core` I/O-pure; the engine writes artifacts + store KV (real I/O), so a dedicated package makes the boundary explicit. *(OQ-1: confirm new package vs in-core.)* |
| DS-2 | State machine | **Hand-rolled FSM** (explicit transition table + guards) | The lifecycle is linear-with-gates + jump-anywhere + bypass — a small inspectable FSM fits; xstate is overkill (designed for nested/parallel UI states) and adds a heavy dep. Matches Noir's "no fragility / no heavy deps" stance. *(OQ-2.)* |
| DS-3 | Gates | **Programmatic + observable checkpoint** (escapable via `--force`, logged) | Blueprint §9.1: replace Superpowers' rhetorical intimidation with one quiet, observable checkpoint that records the decision. Not a hard block (escapable, D4); every bypass is audited. Grounded in approval-gate/audit-trail best practice. *(OQ-3.)* |
| DS-4 | Persistence | **Store KV** (S1) for machine state + **`.noir/` markdown** for artifacts | Single source of truth: the store holds current task/phase/state (fast, queryable); `.noir/` holds human-readable lifecycle docs (specs/plans/tasks/decisions/audit). Survives sessions → resume. |
| DS-5 | Modes | **Full / Quick / Resume** | Discipline by default (Full, all gates); Quick for trivial tasks (stub spec + verify, still disciplined); Resume detects in-flight work at session start. |
| DS-6 | MCP surface | **`noir.checkpoint` + `noir.workflow_status`** in S4 | Minimal host-facing surface (save/restore + status). The spec/plan/task *authoring* tools overlap with the model layer (S8) — defer until S8 can draft. *(OQ-2.)* |

---

## 3. Architecture

```
┌──────────────────────────────────────────────┐
│  @noir-ai/workflow  (the engine)             │
│   WorkflowEngine  · StateMachine · Phases    │
│   Gates (observable checkpoint) · Modes      │
│   ArtifactWriter (.noir/specs|plans|tasks…)  │
├──────────────────────────────────────────────┤
│  @noir-ai/store  (KV state + audit)          │
│  @noir-ai/core   (ProjectId, types — ~no I/O)│
└──────────────────────────────────────────────┘
   .noir/{specs,plans,tasks,decisions,audit}/  (markdown artifacts)
```

Dependency direction: `core` ← `store` ← `workflow` ← (later) `daemon`/`cli`. `workflow` depends on `core` + `store`. No cycles.

---

## 4. The lifecycle & state machine

```
Intake → Clarify → Spec ─► Plan ─► Execute ─► Verify ─► Document
                   [GATE]    [GATE]              [GATE]
```

| Phase | Output artifact | Notes |
|---|---|---|
| Intake | `.noir/intake.md` | raw idea / ticket / issue |
| Clarify | `.noir/clarifications.md` | ambiguities → questions; resolved assumptions logged |
| Spec | `.noir/specs/<id>-<slug>.md` | what/why, acceptance criteria, constraints, **non-goals** |
| Plan | `.noir/plans/<id>.md` + `.noir/tasks/<id>/*` | technical design + task breakdown |
| Execute | impl + task-status deltas | hands tasks to the host CLI |
| Verify | test/lint/acceptance results | validates against spec criteria |
| Document | doc deltas + CHANGELOG + ADR stub | + memory consolidation hook (S7) |

**Per-task state machine:** `draft → clarifying → specified → planned → executing → verifying → done` (+ `blocked` / `abandoned`). Persisted in store KV under a `workflow:<taskId>` key.

- **Transitions** are an explicit table (`from → to` + guard). Illegal transitions throw (with a helpful message: which gate/phase is missing).
- **Jump-to-any-phase** is allowed (`workflow advance --to verify`); the entry point is recorded so the audit shows the jump.
- **Gates** (Spec/Plan/Verify) are checkpoint functions: they record `{ phase, decision: approved|forced|skipped, reason?, at }` to the audit log before allowing the transition. `--force` sets `decision: forced` + requires a reason.

---

## 5. Gates — observable, not rhetorical (§9.1)

A gate is a **programmatic checkpoint**, not a prompt instruction:
```ts
interface GateResult { phase: Phase; decision: 'approved' | 'forced' | 'skipped'; reason?: string; at: number; }
// the engine records every GateResult to the audit log (store KV → exportable to .noir/audit/)
```
- **Full mode:** every gate requires an explicit `approve` (the host/user signals approval via the `noir.checkpoint`/status tool or CLI).
- **`--force`:** bypasses a gate; `decision: 'forced'` + a required reason; always audited.
- **Quick mode:** gates are `skipped` (still recorded, not silently dropped); a stub spec is written + verify still runs.
- This is the Noir answer to Superpowers' rhetorical enforcement (§9.1): *evidence-based nudge + observability over intimidation*. No ALL-CAPS haranguing; the audit trail is the discipline.

---

## 6. Modes & resume

- **Full** (default): all phases + gates; the disciplined path.
- **Quick** (`--quick`): `Intake → (stub Spec) → Execute → Verify` — for trivial tasks; still stubs a spec + runs verify (discipline lite).
- **Resume:** at session start, the engine reads store KV for an in-flight task (`state ≠ done/abandoned`) and surfaces it (via `workflow_status`); `noir.checkpoint` saves/restores the full state for cross-session resume.

---

## 7. Persistence & artifacts

- **Machine state:** store KV keys `workflow:active` (current task id) + `workflow:<taskId>` (phase/state/history/audit-pointer). The store is the single writer (daemon-owned per S1/S2).
- **Artifacts:** `.noir/{intake.md, clarifications.md, specs/<id>-<slug>.md, plans/<id>.md, tasks/<id>/*, decisions/<n>-*.md, audit/<taskId>.json}`. Markdown for human-readable lifecycle docs; audit as JSON (exportable).
- **Idempotency:** re-running a phase/checkpoint is safe (artifacts use marker blocks / append-only audit; state transitions are guarded by the FSM).

---

## 8. MCP surface (minimal for S4)

- `noir.checkpoint` — save/restore workflow state (args: `{ action: 'save'|'restore', taskId? }`); powers cross-session resume.
- `noir.workflow_status` — returns `{ taskId, phase, state, nextGate?, mode, history }`; the host's view of in-flight work.
- *(Full authoring tools — `spec_*`/`plan_*`/`task_*` — are deferred until the model layer (S8) can draft; see OQ-2. The engine exposes the lifecycle + state; drafting is a separate concern.)*

---

## 9. Testing & CI

- **Unit:** FSM legal/illegal transitions; gate recording (approved/forced/skipped → audit entries); modes (Full/Quick gate behavior); jump-to-phase records entry.
- **Integration:** resume across a re-opened store (state survives `close()`/re-`openStore()`); `--force` audit; artifact files written with correct paths.
- **Property-style:** no sequence of `--force`/jumps leaves the state machine in an undefined state.
- No network; no LLM (drafting is S8). CI matrix unchanged (ubuntu+macos, node 22).

---

## 10. Out of scope (deferred — explicit)

| Deferred | Target | Why |
|---|---|---|
| Spec/plan/task **drafting** by an LLM | S8 | Needs the bounded model layer. |
| Context retrieval into the spec/plan | S6 | Needs the context index. |
| Memory capture at gates (decisions→memory) | S7 | Needs the memory subsystem; S4 writes the audit, S7 lifts decisions into memory. |
| The TUI home screen | S9 | S4 is headless (engine + MCP). |
| Cross-task / parallel tasks | later | v1 = one active task per project. |
| Full `spec_*`/`plan_*`/`task_*` authoring MCP tools | when S8 lands | Overlap with model drafting. |

---

## 11. Open questions — RESOLVED (2026-07-24 review)

- **OQ-1 → new `@noir-ai/workflow` package (6th; depends core + store).** Core stays I/O-pure; engine's artifact/KV writes are explicit. (confirms DS-1)
- **OQ-2 → hand-rolled FSM** (explicit transition table + guards). xstate is overkill + a heavy dep; matches the "no fragility / no heavy deps" stance. (confirms DS-2)
- **OQ-3 → observable + escapable gates** (programmatic checkpoint records approved/forced/skipped; `--force` bypass with a reason, always audited). Per §9.1 — quiet + observable, not rhetoric, not a hard block. (confirms DS-3)
- **OQ-4 → minimal MCP surface in S4:** `noir.checkpoint` + `noir.workflow_status`. The full `spec_*`/`plan_*`/`task_*` authoring tools defer to when S8 (model layer) can draft. (confirms DS-6)
- **OQ-5 → audit in store KV as source of truth + export to `.noir/audit/<taskId>.json`** (queryable via the store + human-inspectable).
- **OQ-6 → Document phase + artifact stubs in S4** (CHANGELOG-entry stub, ADR stub via the existing `docs/decisions/` pattern); full LLM generation later (S8).

---

## 12. References

- SDD landscape 2026: [Spec Kit vs Kiro](https://codemyspec.com/blog/spec-kit-vs-kiro) · [Martin Fowler — SDD tools](https://martinfowler.com/articles/exploring-gen-ai/sdd-3-tools.html) · [Kiro specs docs](https://kiro.dev/docs/internal/specs/) · [GitHub Spec Kit blog](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)
- Gates/audit: [Framework for dev workflows with approval steps](https://blog.brightcoding.dev/2025/12/30/framework-for-development-workflows-with-approval-steps-a-complete-safety-first-guide) · [Audit trails for automated workflows](https://gsconsultingllc.com/insights/building-audit-trails-automated-workflows)
- Parent: `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (§6.1 lifecycle, §9.1 observable-checkpoint).

---

## 13. Next steps

1. ~~User reviews this draft — confirm OQ-1…OQ-6.~~ **Reviewed 2026-07-24: all OQs resolved (§11).**
2. → **writing-plans** → subagent-driven implementation (same as S1).
