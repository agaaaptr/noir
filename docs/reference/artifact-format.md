# Generated-artifact format & naming standard

The single source of truth for every **file a skill generates under `.noir/`** — how it is named, where it lives, what frontmatter it carries, and what shape each type takes. The quality gate (`noir skills lint`) cross-checks skill bodies against the registry in [`ARTIFACT_TYPES`](../../packages/core/src/artifacts.ts), and the workflow writers + CLI handoff writer build filenames from it.

Scope: **`.noir/` generated artifacts only**. Human-authored repo docs (`docs/internal`, `docs/decisions`) deliberately keep their own convention — two standards, explicitly permitted.

## Naming

```
<CODE>-<NNNN>-<taskId>-<slug>.md
```

- **`CODE`** — a 2-letter type code (or the natural acronyms `PRD`/`ADR`). See the registry below.
- **`NNNN`** — a **per-type** monotonic sequence, zero-padded to 4 digits, never reused. Computed by scanning the type directory and taking `max+1`.
- **`taskId`** — the store key the artifact belongs to (omitted for kinds not tied to a task).
- **`slug`** — kebab-case, ASCII, hyphens-not-underscores (omitted for `intake`/`handoff`).

Token order (`CODE-NNNN-taskId-slug`) makes a lexical sort within a type directory equal generation order. Rewriting reuses the existing file (no duplicate sequence numbers).

## Registry

| Kind | Code | Directory | Pattern |
|---|---|---|---|
| Task | `TS` | `.noir/tasks/` | `TS-0001-<taskId>-<slug>.md` |
| Spec | `SP` | `.noir/specs/` | `SP-0001-<taskId>-<slug>.md` |
| Plan | `PL` | `.noir/plans/` | `PL-0001-<taskId>-<slug>.md` |
| PRD | `PRD` | `.noir/prd/` | `PRD-0001-<taskId>-<slug>.md` |
| Analysis | `AN` | `.noir/analysis/` | `AN-0001-<taskId>-<slug>.md` |
| ADR | `ADR` | `.noir/decisions/` | `ADR-0001-<slug>.md` |
| Bug report | `BG` | `.noir/bugs/` | `BG-0001-<taskId>-<slug>.md` |
| Subagent brief | `BR` | `.noir/subagents/` | `BR-0001-<slug>.md` |
| Subagent report | `RP` | `.noir/subagents/` | `RP-0001-<slug>.md` |
| Clarification | `CL` | `.noir/clarifications/` | `CL-0001-<taskId>-<slug>.md` |
| Intake | `IN` | `.noir/intake/` | `IN-0001-<taskId>.md` |
| Handoff | `HO` | `.noir/handoff/` | `HO-0001-<taskId>.md` |

Uncoded (not per-type documents): `.noir/CHANGELOG.md` (append-only) and `.noir/audit/<taskId>.json` (deterministic machine export).

## Frontmatter

Every workflow-written or skill-authored `.md` artifact carries YAML frontmatter as the first bytes (no BOM, single leading `---` block). The `handoff` artifact is the one exception — `noir handoff --write` emits engine-rendered fixed headings with no frontmatter (see the per-type outlines below). Required fields:

```yaml
---
kind: plan            # enum = one of the 12 kinds above
id: t4k3b1e9          # the store key (taskId) — or ADR-0007 for decisions
slug: artifact-format # required only for kinds that carry one — omitted for intake and handoff
title: Artifact format
status: draft         # lifecycle kinds: draft | review | approved | done ; adr: proposed | accepted | rejected | superseded
date: 2026-08-13      # ISO-8601
generated_by: "@noir-ai <version>"
generated_at: 2026-08-13T09:00:00Z   # RFC3339
---
```

Reserved (declared optional in ADR-0007; not yet written or validated by any code): `version`, `author`/`owner`, `tags`, `related`, `supersedes`, `source`, `checksum` (`sha256:…`).

`slug` is conditional, not unconditional: the writer emits it only when a slug is passed, and the registry marks `intake` and `handoff` as carrying none — so it is required for every kind except those two (see Naming above).

**Invariant:** `filename code == frontmatter kind == directory`. The gate enforces only the filename-code-vs-directory half, and only for paths a skill prescribes: `artifactPathDrift` scans skill bodies and references for `.noir/<dir>/<name>` strings and requires the filename to carry one of that directory's type codes — it never opens or parses an artifact. The frontmatter `kind` is emitted by the artifact writers and is not checked by any gate; nor does the frontmatter half apply to the `handoff` artifact, which carries no frontmatter at all.

## Per-type outlines

### SPEC — the behavior contract
Goal · Scope (in) · Non-goals (out) · Users/personas · Requirements (normative `SHALL`/`MUST`, each with GIVEN/WHEN/THEN scenarios) · Acceptance criteria · Constraints · Testing strategy · Open questions · References.

### PLAN — ordered execution
Goal · Architecture · Tech stack · Spec pointer (links REQ-IDs) · Global constraints · Ordered tasks (checkbox `- [ ]`, each with Files / Implementation steps / Verification / Rollback) · Dependency graph · Risks & mitigations · Definition of done.

### TASK — one atomic unit (≤1 page, ≤2 days)
Title (Verb + Object + Constraint) · Context (1–3 lines + spec/plan link) · Acceptance criteria / Definition of Done · Steps · Notes.

### ANALYSIS — compare options before deciding
Context & problem (as a question) · Current state & forces · Considered options (pros/cons/cost) · Comparison & trade-offs · Recommendation · Risks & mitigations · Success metrics · Open questions → next step.

### ADR — the immutable record
Title (`ADR-NNNN: <noun phrase>`) · Status · Date + decision-makers · Context · Considered options · Decision (`We will …`) · Consequences (positive, negative, neutral) · References. Supersede, never edit.

### PRD — the pre-SDD product artifact
Problem · Evidence · Audience · Success Criteria · Appetite/Mode · Proposed Direction · No-gos · Rabbit holes · Open Questions. (Matches `@noir-ai/model`'s `draftPrd`.)

### Bug report / brief / report / handoff / intake / clarification
Light outlines (frontmatter core + free body); `brief` = Goal · Files (incl. must-NOT-touch) · Constraints · Acceptance · Context; `report` = done / test results / issues; `handoff` = engine-rendered fixed headings.

## Enforcement

- **`validateSkill` (hard):** a skill body or reference that names a `.noir/` directory absent from the registry, or a filename missing the type-code prefix, fails validation.
- **`lintSkill` (soft):** advisory warnings (thin body, no examples, missing sections, …).
- `noir skills lint` runs over every builtin in CI (`builtin-hygiene.test.ts`).

## Related

- [`docs/decisions/0007-generated-artifact-standard.md`](../decisions/0007-generated-artifact-standard.md)
- [`docs/internal/specs/2026-08-13-c3-generated-artifact-standard-design.md`](../internal/specs/2026-08-13-c3-generated-artifact-standard-design.md)
- [`packages/core/src/artifacts.ts`](../../packages/core/src/artifacts.ts)
