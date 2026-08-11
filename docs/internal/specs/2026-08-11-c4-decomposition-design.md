# C4 Capability → Slice Decomposition + rollback_plan — a Spec-of-Specs roadmap pass (spec)

> Capability-04 delta: no capability→slice decomposition exists — the plan phase writes hand-authored `plan.md`/`task.md`, and the audit established this is a **roadmap invention with no spec backing** (the only "slices" in the design corpus are roadmap milestones). The research synthesis converges on a **Spec-of-Specs pattern**: a capability-level artifact — one shallow table per capability with stable ID, one-line intent, scope boundary, depends-on, status — where each slice then re-enters the existing clarify→spec→plan FSM as its own cycle. The field consensus is a **hybrid decomposition**: fixed output schema + LLM content + deterministic validation (schema checks, dependency-cycle detection, real test/lint commands) + human approval gates. Noir's strongest differentiation opportunity: **`rollback_plan` as a first-class per-slice artifact** — almost no tool derives it, and it ties directly to Noir's verify gate.
>
> Internal docs follow `docs/internal/specs/`. Research basis: GitHub spec-kit "Spec of Specs" + task-generator, OpenPlanr artifact hierarchy, INVEST (Wake) + SPIDR slicing (Cohn) + Hamburger method (Adzic), the UK-gov ADR framework (ADRs orthogonal to decomposition), Cockburn's walking skeleton, and the sdd-task decomposition skill.

## Goal

1. **A capability→slice roadmap pass** (`noir task decompose`) that turns a capability description (or its `spec.md`) into a validated `SlicePlan` — objective, scope boundary, dependencies, acceptance, testing, and **rollback** per slice, auto-derived into a fixed schema (LLM-drafted, deterministic-validated, human-approved).
2. **Each slice becomes a workflow task** — its own `intake→clarify→spec→plan→execute→verify→document` cycle, with dependency edges guiding `noir task next`.
3. **`rollback_plan` is first-class** — an operator-executable halt/revert procedure per slice, enforced by the verify gate (fails loudly when absent for production classes) — Noir's differentiation.
4. **Walking-skeleton first + Spike slices** — routing rules so the thinnest shippable slice lands first and uncertainty gets an explicit Spike.
5. **Spec/plan/tasks separation preserved** — decomposition lives *above* spec; ADRs stay an orthogonal, immutable decision log.

## Scope

### S1 — `SlicePlan` schema (fixed, machine-checkable)

**`packages/workflow/src/slices.ts`** (new) — the typed, validatable schema:

```ts
export type SliceType = 'feature' | 'tech' | 'spike';
export interface Slice {
  id: string;                       // stable, greppable, e.g. "s1-walking-skeleton"
  title: string;
  type: SliceType;
  rationale: string;                // 1-3 sentences — drift is flaggable against this
  scopeIn: string;                  // what this slice delivers
  scopeOut: string;                 // explicitly deferred to sibling slices (boundary)
  dependsOn: { id: string; mode: 'sequential' | 'parallel' }[];
  files: { create: string[]; modify: string[]; preserve: string[] }; // or globs
  acceptance: string[];             // concrete commands/assertions (deterministic)
  doD: string[];                    // build/test/typecheck commands
  rollbackPlan: {
    procedure: string;              // operator-executable halt/revert steps
    verifyCommand?: string;         // how to confirm the revert worked
  };
}
export interface SlicePlan {
  capabilityId: string;             // e.g. "C4"
  intent: string;                   // one-line capability intent (Spec-of-Specs "Intent")
  slices: Slice[];
  status: Record<string, 'planned' | 'in-progress' | 'done'>; // roadmap status
}
```

- `dependsOn` is topologically validated (no cycles, `id` refs exist, parallel siblings don't conflict on the same file list).
- Persisted at `.noir/slices/<capabilityId>-<slug>.json` (source of truth) + a rendered `.md` (Spec-of-Specs table) via the conflict seam. This is the **capability-level artifact above spec** the research calls for.

### S2 — `noir task decompose` (LLM-drafted, deterministic-validated, human-approved)

- **`packages/model/src/draft-slice-plan.ts`** (new) — a single-shot, provider-explicit completion that fills the `SlicePlan` JSON schema from a capability description or `spec.md`. Mirrors the `draftPrd` pattern (P3): **offline → template with placeholder slices; `null` on no-provider/failure; never runs a tool loop** (the model layer has no `tools`/`stream` — agent loops impossible by construction).
- **`packages/cli/src/commands/task.ts`** — `noir task decompose <capability|spec-path> [--out <path>]`:
  1. Draft the plan (LLM when a provider is configured, else template + clear "no provider — template drafted" note).
  2. **Deterministic validation:** schema conformance, duplicate IDs, dependency-cycle detection (topo sort), field completeness (every slice needs `acceptance`, `doD`, `rollbackPlan` — a `spike` slice may relax `rollbackPlan`), file-list conflicts between parallel siblings.
  3. Render the Spec-of-Specs table + per-slice summaries for **human approval** (`y/N`, `--yes` skips). Approval writes `.noir/slices/<capabilityId>-<slug>.json` (conflict seam).
  4. Seed slices as workflow tasks (`workflow_start` per slice with a generated slug) and record the dependency graph in the audit KV (`slices:<capabilityId>` → `{ id, dependsOn, status }`), so `noir task next` (S4) can route.
- **Deterministic validation lives in code, not LLM judgment** (research: "deterministic validation (schema validation, dependency-cycle detection, real test/lint/typecheck commands) + human approval gates at roadmap and per-slice").

### S3 — `rollback_plan` as first-class, verify-gated

- Every non-spike slice carries `rollbackPlan` (S1). This is the artifact the research identifies as Noir's best differentiation ("make rollback a designed property of the plan, not an emergency procedure").
- **Verify-gate enforcement** (integrates with `2026-08-11-c4-verify-gate-recovery-design.md` S5's DoD checklist): for production classes (`feature`/`epic`), the verify-gate evidence must include a check that the task's slice has a `rollbackPlan` — **absent → the verify gate records a soft-fail** (observable; never silent) with the task id's `rollbackPlan.missing` flagged. Hard-fail for `feature`/`epic` when configured (right-sized per class).
- `rollbackPlan.verifyCommand` reuses the verify-gate evidence machinery: the operator's rollback procedure is itself checkable.

### S4 — Routing: walking-skeleton first + Spike slices

- **`noir task next`** (existing command) gains slice awareness: it prefers the slice whose `dependsOn` are all `done`, with the **walking-skeleton slice first** (the thinnest end-to-end slice linking the main architecture — Cockburn) when multiple are eligible. Slices with parallel markers that don't conflict on files may be suggested together.
- **Spike routing:** a `spike`-type slice maps to a `spike` taskClass (the existing class) — non-estimable slices get a bounded Spike cycle before a real slice can be estimated (INVEST's Estimable as read-release, not a hard gate).
- **INVEST as a soft check:** the decomposition validation + the soft PRD gate check Valuable + Testable (the INVEST must-haves) — advisory, never hard-blocking on Independent/Negotiable (INVEST is a guideline, not dogma).

### S5 — Decomposition is above the FSM, ADRs stay orthogonal

- Decomposition produces the capability-level artifact and *seeds* lifecycle tasks; it is **not** an FSM state and does not replace `intake→clarify→spec`. Each seeded slice re-enters the existing lifecycle normally.
- **ADR discipline (research):** ADRs are the orthogonal, immutable decision log produced *during* slicing (supersede-not-delete, decision-log semantics — UK-gov framework) — not the decomposition mechanism. The `writeDecisionStub` wiring (verify-gate spec S8) records slice-level decisions at `done`; decompose itself writes no ADRs.
- spec.md (WHAT) / plan.md (HOW) / tasks.md (executable units) / slices.md (capability table) stay strictly separated.

## Non-goals

- **No auto-implementation.** Decomposition drafts the plan; each slice is implemented through the normal lifecycle (spec→plan→execute→verify→document). It does not bypass gates.
- **No slice-level parallel execution engine.** The daemon is the single writer; `dependsOn` parallel markers are **routing hints** for `noir task next`, not a multi-writer executor. True parallel slices with store-write contention are a v2 concern (ADR-0006).
- **No LLM-free-form output.** Content is drafted by a single-shot completion into a fixed schema and always passes deterministic validation + human approval — never raw prose accepted as the plan.
- **No change to the artifact taxonomy of existing tasks** — existing `plan.md`/`task.md` stays; the slice schema is additive for decompose-seeded tasks.
- **No host-specific decomposition modes** — the schema + validation are host-agnostic core; only the drafting uses the provider-explicit model layer.

## Acceptance criteria

1. `noir task decompose C4` (or a spec path) with a provider configured produces a validated `SlicePlan` (schema-conformant, no dependency cycles, no duplicate IDs, complete `acceptance`/`doD`/`rollbackPlan`), renders the Spec-of-Specs table, requires approval (or `--yes`), and persists `.noir/slices/C4-<slug>.json`.
2. Without a provider, decompose produces a template plan + a clear "no provider — template drafted" note (no crash, no silent empty).
3. A malformed draft (cycle, duplicate ID, missing required field) is **rejected deterministically** with a specific validation error — not passed through to approval.
4. Approved slices seed workflow tasks; `noir task next` routes to the eligible slice with the walking-skeleton slice first; a `spike` slice maps to `taskClass: spike`.
5. A `feature`-class task whose slice has no `rollbackPlan` fails the verify gate's DoD soft-check (observable soft-fail); with `required` config for `feature`/`epic`, it hard-fails — `rollbackPlan.verifyCommand` integrates with the evidence machinery.
6. A dependency cycle or file conflict between parallel siblings is rejected at decompose-time with a pointer to the conflicting `dependsOn`/`files` entries.
7. Full gate green: lint → build → typecheck → test → docs:validate (offline; decompose's model drafting is cassette-mocked, never a live paid call).

## Testing strategy

- **Schema/validation unit (`slices.test.ts`):** topo validation (acyclic, refs exist), duplicate-ID rejection, field completeness, parallel file-conflict detection, spike relaxation of `rollbackPlan`.
- **Model drafting:** `draftSlicePlan` offline→template and provider paths (mock provider; assert no tool-call loop, single-shot only — mirrors `draftPrd` tests).
- **CLI integration:** `noir task decompose` happy path (draft→validate→render→approve→persist→seed), rejection paths, `--yes`, `--out`, template fallback; **no network**.
- **`noir task next` routing:** dependency-aware slice selection, walking-skeleton first, spike mapping.
- **Verify-gate DoD integration:** rollbackPlan-missing soft/hard fail paths wired through the verify-gate evidence checks.
- **Docs:** capability-04 delta #4 status; `docs/explanation/sdd-workflow.md` (decomposition section); `docs/reference/cli-auto.md`.

## Rollback

- **Additive:** new `slices.ts` schema, new model drafting fn, new CLI command, new KV keys (`slices:<capabilityId>`) — none alter existing FSM behavior. A task seeded by decompose is a normal task.
- **Behavioral coupling:** the rollback-plan DoD check engages only for slices/tasks created via decompose (they carry the schema) and classes configured for it; legacy tasks without a slice record are unaffected.
- **Rollback:** remove the command + schema + DoD check; existing tests pass unchanged. Persisted `.noir/slices/*.json` can be deleted without affecting tasks already seeded (they are independent TaskStates).
- **Migration:** none — no store schema change.

## References

- `packages/workflow/src/slices.ts` — new `SlicePlan`/`Slice` schema + validation
- `packages/model/src/draft-slice-plan.ts` — new single-shot drafting fn (mirrors `packages/model/src/draft.ts` `draftPrd`)
- `packages/cli/src/commands/task.ts` — `noir task decompose`, `noir task next` (slice-aware routing)
- `packages/daemon/src/server.ts` — seeding via `workflow_start`; `slices:<capabilityId>` KV via the store
- `packages/workflow/src/types.ts` — `TaskClass` (`spike`), `WorkflowGateConfig.verify` (rollback-plan DoD check, cross-ref verify-gate spec)
- Docs to sync: `docs/roadmap/capability-04-ai-development-workflow.md`, `docs/explanation/sdd-workflow.md`, `docs/reference/cli-auto.md`, `docs/roadmap/backlog.md`
- Cross-ref: `docs/internal/specs/2026-08-11-c4-verify-gate-recovery-design.md` (S5 DoD, S8 document wiring)
