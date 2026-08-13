# C3 Generated Artifact Standard — file naming + frontmatter + per-type format (spec)

> Capability-03 (Built-in Skill System) delta. Today every `noir-` skill that tells the host to **generate a file** (spec, plan, PRD, task, analysis, decision record, bug report, subagent brief/report, handoff, intake, clarification) invents its own filename and body shape — and several drift from the engine's canonical writers. The audit found **29 file-generating surfaces** with three conflicting naming families, no frontmatter, no provenance, a PRD template that diverges between the `noir-prd` skill (6 sections) and `@noir-ai/model`'s `draftPrd` (9 sections), two parallel ADR homes, and a quality gate that validates only the *skill files*, never the *files skills tell the host to generate*.
>
> This spec standardizes **the output**: one type-code registry, one deterministic naming scheme, one frontmatter contract, one outline per file type, and — critically — an **enforceable invariant** (`filename code == frontmatter kind == directory`) checked by the existing C3 gate. Scope is **`.noir/` generated artifacts only**; human-authored repo docs (`docs/internal`, `docs/decisions`) deliberately stay on their current convention.
>
> Research basis (≥5 sources per dimension, compared): file naming (RFC 7322, Nygard ADR numbering, MADR `NNNN-title-with-dashes.md`, adr-tools, Jekyll/W3C ISO-8601 date prefix, Log4brains date-ADR, Google/WtD/GitLab kebab-case slugs, Diátaxis type-directories); frontmatter (Jekyll/Hugo/Pandoc/Obsidian, Microsoft HVE Core JSON-Schema validation, remark-lint, MADR status lifecycle, thane-ai-agent `generated_by`/`generated_at`/`refresh_strategy`, Morphir `source`/`checksum`); doc formats (Google design doc, Rust RFC, OpenSpec GIVEN/WHEN/THEN, Shape Up pitch, Microsoft PromptKit implementation-plan, GitHub issue forms, Amazon PR/FAQ, Nygard/MADR ADR); AI-output hygiene (Go `DO NOT EDIT` marker, managed-block no-clobber, PyTorch idempotent atomic writes, docs-as-code CI, LLVM/Kubernetes/Modular AI-disclosure).

## Goal

Every file a C3 skill generates under `.noir/` is **self-identifying, deterministic, machine-validatable, and follows one per-type outline** — so an agent (or human) can read the filename and know the type, generation order, and subject, and so the gate can catch drift automatically:

1. **One naming scheme** — `<CODE>-<NNNN>-<taskId>-<slug>.md`, with a canonical type-code registry (12 codes + ADR/PRD acronyms), per-type monotonic `NNNN`.
2. **One frontmatter contract** — required `kind`/`id`/`slug`/`title`/`status`/`date`/`generated_by`/`generated_at`, JSON-Schema-validatable.
3. **One outline per type** — full outlines for SPEC / PLAN / TASK / ANALYSIS / ADR; canonical PRD (resolves the 6-vs-9 divergence); light outlines for bug / brief / report / handoff / intake / clarification.
4. **One enforcement point** — the C3 gate (`validateSkill` hard, `lintSkill` soft) cross-checks every `.noir/…` path a skill prescribes against the registry, and the engine writers emit the same contract. Invariant: **filename code == frontmatter `kind` == directory**.

## Scope

### S1 — Type-code registry (single source of truth)

A new `packages/core/src/artifacts.ts` exports the canonical registry and the two functions everything else reuses. This is the **one contract** the gate and the writers both read — no duplicated string literals anywhere else.

```ts
// packages/core/src/artifacts.ts
export const ARTIFACT_TYPES = {
  task:          { code: 'TS',  dir: 'tasks',          ext: '.md', hasTaskId: true,  hasSlug: true  },
  spec:          { code: 'SP',  dir: 'specs',          ext: '.md', hasTaskId: true,  hasSlug: true  },
  plan:          { code: 'PL',  dir: 'plans',          ext: '.md', hasTaskId: true,  hasSlug: true  },
  prd:           { code: 'PRD', dir: 'prd',            ext: '.md', hasTaskId: true,  hasSlug: true  },
  analysis:      { code: 'AN',  dir: 'analysis',       ext: '.md', hasTaskId: true,  hasSlug: true  },
  adr:           { code: 'ADR', dir: 'decisions',      ext: '.md', hasTaskId: false, hasSlug: true  },
  bug:           { code: 'BG',  dir: 'bugs',           ext: '.md', hasTaskId: true,  hasSlug: true  },
  brief:         { code: 'BR',  dir: 'subagents',      ext: '.md', hasTaskId: true,  hasSlug: true  },
  report:        { code: 'RP',  dir: 'subagents',      ext: '.md', hasTaskId: true,  hasSlug: true  },
  clarification: { code: 'CL',  dir: 'clarifications', ext: '.md', hasTaskId: true,  hasSlug: true  },
  intake:        { code: 'IN',  dir: 'intake',         ext: '.md', hasTaskId: true,  hasSlug: false },
  handoff:       { code: 'HO',  dir: 'handoff',        ext: '.md', hasTaskId: true,  hasSlug: false },
} as const;

export type ArtifactKind = keyof typeof ARTIFACT_TYPES;

/** `TS-0001-<taskId>-<slug>.md` — zero-padded per-type sequence, taskId when present, slug when present. */
export function artifactFileName(kind: ArtifactKind, nnnn: number, taskId?: string, slug?: string): string;
/** Scan `.noir/<dir>/` for `<CODE>-NNNN-…` and return max+1 (1 when none). Mirrors the existing ADR scan. */
export function nextArtifactSequence(root: string, kind: ArtifactKind): number;
```

`NNNN` is **per-type**, zero-padded to 4 digits, scan-based `max+1` (the exact pattern the decision-stub scan already uses at `cli/commands/task.ts:142-152`), **never reused**. Two exceptions stay uncoded (they are not per-type documents): `.noir/CHANGELOG.md` (append-only) and `.noir/audit/<taskId>.json` (deterministic machine export).

### S2 — Filename scheme

`<CODE>-<NNNN>-<taskId>-<slug>.md`, assembled by `artifactFileName`:

| Type | Code | Directory | Example |
|---|---|---|---|
| Task | `TS` | `.noir/tasks/` | `TS-0001-t4k3b1e9-fix-auth-timeout.md` |
| Spec | `SP` | `.noir/specs/` | `SP-0002-t4k3b1e9-c3-artifact-format.md` |
| Plan | `PL` | `.noir/plans/` | `PL-0003-t4k3b1e9-c3-artifact-format.md` |
| PRD | `PRD` | `.noir/prd/` | `PRD-0004-t4k3b1e9-tui-redesign.md` |
| Analysis | `AN` | `.noir/analysis/` *(new)* | `AN-0005-t4k3b1e9-embedder-options.md` |
| ADR | `ADR` | `.noir/decisions/` | `ADR-0007-c3-artifact-standard.md` *(NNNN = decision number)* |
| Bug | `BG` | `.noir/bugs/` *(new)* | `BG-0006-t4k3b1e9-windows-npmbin.md` |
| Brief | `BR` | `.noir/subagents/` *(new)* | `BR-0007-t4k3b1e9-decompose-audit.md` |
| Report | `RP` | `.noir/subagents/` *(new)* | `RP-0008-t4k3b1e9-decompose-audit.md` |
| Clarification | `CL` | `.noir/clarifications/` | `CL-0009-t4k3b1e9-research-questions.md` |
| Intake | `IN` | `.noir/intake/` | `IN-0010-t4k3b1e9.md` |
| Handoff | `HO` | `.noir/handoff/` | `HO-0011-t4k3b1e9.md` |

Token order is `CODE-NNNN-taskId-slug` so a lexical sort within a type directory equals generation order. ADR uses the decision number as its `NNNN` (no `taskId`). Slug is kebab-case, ASCII, hyphens-not-underscores.

### S3 — Frontmatter contract

Every `.md` artifact above carries YAML frontmatter as the **first bytes** (no BOM, single leading `---` block). Required fields (missing ⇒ validation fails):

```yaml
---
kind: plan            # enum = the 12 ArtifactKind values above (== the code's full word)
id: t4k3b1e9          # taskId (store key) — or ADR-0007 for decisions
slug: c3-artifact-format
title: Standardize C3 skill-generated file format and naming
status: draft         # lifecycle kinds: draft|review|approved|done ; adr: proposed|accepted|rejected|superseded
date: 2026-08-13      # ISO-8601
generated_by: noir-planning / @noir-ai 1.10.0
generated_at: 2026-08-13T09:00:00Z   # RFC3339
---
```

Optional (validated when present): `version` (semver, document version distinct from tool version), `author`/`owner`, `tags`, `related` (ids), `supersedes` (required when `status: superseded`), `source` (paths/URLs the doc derived from), `checksum` (`sha256:…`).

Backward-compat: the current writers emit only `taskId:`/`slug:`; the new writers **add** fields — additive, non-breaking. Consumers key off `id` (taskId) and `kind`, never off filename alone.

### S4 — Per-type outlines

Full (required sections):

- **SPEC** — the behavior contract: Goal · Scope (in) · Non-goals (out) · Users/personas · Requirements (normative `SHALL`/`MUST`, each with GIVEN/WHEN/THEN acceptance scenarios) · Acceptance criteria · Constraints · Testing strategy · Open questions · References. *(Keep the existing `noir-spec` 7-section skeleton; add numbered Requirements with scenarios.)*
- **PLAN** — ordered execution: Goal · Architecture · Tech stack · Spec pointer (links REQ-IDs, never restates) · Global constraints · Ordered tasks (checkbox `- [ ]`, each with Files / Implementation steps / Verification / Rollback) · Dependency graph + critical path · Risks & mitigations · Definition of done. *(Keep the repo plan head; the checkbox list is already mandated by `noir-planning` and consumed by the verify gate.)*
- **TASK** — one atomic unit (≤1 page, ≤2 days): Title (Verb + Object + Constraint) · Context (1–3 lines + spec/plan link) · Acceptance criteria / Definition of Done (observable checkboxes) · Steps · Notes.
- **ANALYSIS** — compare options before deciding: Context & problem (as a question) · Current state & forces · Considered options (pros/cons/cost) · Comparison & trade-offs · Recommendation · Risks & mitigations · Success metrics · Open questions → next step (proceed to ADR?).
- **ADR** — the immutable record: Title (`ADR-NNNN: <noun phrase>`) · Status · Date + decision-makers · Context (value-neutral forces) · Considered options (why the losers lost) · Decision (`We will …` active voice) · Consequences (positive, negative, neutral) · References. Supersede, never edit.

Canonical fixes:

- **PRD** — the canonical PRD is `@noir-ai/model`'s `draftPrd` **9-section** set (Problem · Evidence · Audience · Success Criteria · Appetite/Mode · Proposed Direction · No-gos · Rabbit holes · Open Questions — Amazon PR/FAQ + Shape Up grounded). The `noir-prd` skill is updated to list the same 9 (it previously listed 6).
- **BUG** — Title (`BG-NNNN: <summary>`) · Repro steps · Expected vs actual · Environment (OS/Node/noir version) · Impact/severity · References. *(New type — the audit found no bug-report surface.)*
- **BRIEF** — Goal · Files (incl. must-NOT-touch) · Constraints · Acceptance · Context pointer (5–10 lines). **REPORT** — done / test results / issues, structured over prose.
- **HANDOFF** — keep the engine-rendered fixed headings (`# Noir handoff — <name> (<id>)` …).
- **INTAKE / CLARIFICATION** — frontmatter core + free body (no required section list; these are chat-scoped inputs).

### S5 — Engine writer changes

- **`packages/core/src/layout.ts`** — add `analysisDir`, `bugsDir`, `subagentsDir`; change the file builders to delegate to `artifactFileName` (which now needs the `nnnn` argument). `decisionFile` becomes `ADR-<NNNN>-<slug>` (add slug).
- **`packages/workflow/src/artifacts.ts`** — every `.md` writer (`writeIntake`, `writeSpec`, `writePrd`, `writePlan`, `writeTask`, `writeClarifications`, `writeDecisionStub`, handoff) now: computes `nnnn = nextArtifactSequence(root, kind)`, builds the name via `artifactFileName`, and emits the full S3 frontmatter (adds `kind`/`status`/`date`/`generated_by`/`generated_at`). `writeDecisionStub` gains a `slug` param and emits real `status: proposed` frontmatter + the Nygard heading shape (replacing the `<!-- Status: pending -->` comment).
- **`packages/cli/src/commands/task.ts`** — `writeDoneArtifacts`'s decision-number scan is replaced by `nextArtifactSequence(root, 'adr')`, and passes a real title/slug (today it passes the `taskId` as the ADR title). `noir task decompose`'s slice-artifact paths (if any) follow the same scheme.

### S6 — Gate enforcement

- **`packages/skills/src/quality.ts`** — new `artifactPathDrift(skill): ArtifactDrift[]` that regexes the SKILL.md body + `references/` for `.noir/<dir>/…` and filename literals, and cross-checks each against `ARTIFACT_TYPES`. A directive that names a `.noir/` directory that doesn't exist, or a filename pattern that doesn't match `CODE-NNNN-…`, is a **drift**.
- **`validateSkill` (hard)** — fails when `artifactPathDrift` returns non-empty. Today this immediately fails `noir-planning` (`.noir/plans/<date>-<slug>.md`) and `noir-subagent` (`.noir/sdd/task-N-brief.md`, a directory absent from `layout.ts`). Those skill bodies must be corrected in S7.
- **`lintSkill` (soft)** — warns when a file-generating skill prescribes an outline that omits the S4 required sections (advisory, not blocking).
- **`builtin-hygiene.test.ts` / `compiler.test.ts`** — add a case: a skill body quoting a wrong `.noir/` path fails `validateSkill`; correct paths pass.

### S7 — Skill body corrections

Edit the builtins whose output-path/naming directives drift from the registry (each becomes a `fix(skills)` commit-scope touch): `noir-planning` (`<date>` → `PL-NNNN-taskId-slug`), `noir-subagent` (`.noir/sdd/` → `.noir/subagents/` + `BR`/`RP`), `noir-spec` (`<id>` → `SP-NNNN-taskId-slug`), `noir-prd` (`<id>` → `PRD-NNNN-…` + 9-section canon), `noir-brainstorming` (spec-stub → `SP` + frontmatter), `noir-rules` (ADR routing → `ADR-NNNN-slug`), `noir-wrap` (handoff/ADR/CHANGELOG refs), and any other builtin that names a `.noir/` output path. `noir-writing-skills` gains a pointer to the artifact standard for the file it teaches users to author.

### S8 — Reference doc + ADR

- **`docs/reference/artifact-format.md`** — the human-readable home of the standard: the registry table, the naming grammar, the frontmatter schema, the per-type outlines, and the invariant. This is what the gate validates against (today the contract is scattered across `layout.ts`, the S4 spec, and skill bodies).
- **`docs/decisions/0007-generated-artifact-standard.md`** — ADR recording the naming (code + per-type NNNN + taskId retention), the `.noir/`-only scope, the two-standard decision (repo docs unchanged), and the enforcement severity (hard path-drift / soft sections).

## Acceptance criteria

- [ ] `artifactFileName` + `nextArtifactSequence` produce exactly `<CODE>-<NNNN>-<taskId>-<slug>.md` (4-digit per-type sequence, never reused, per-type independent counters).
- [ ] Every `.md` artifact writer emits S3 frontmatter with `kind`/`status`/`date`/`generated_by`/`generated_at`; additive over the old `taskId`/`slug`.
- [ ] `writeDecisionStub` writes `ADR-<NNNN>-<slug>.md` with `status: proposed` frontmatter (no HTML comment).
- [ ] `noir-prd` lists the same 9-section PRD as `draftPrd` (skill + model agree).
- [ ] `layout.ts` exposes `analysisDir`/`bugsDir`/`subagentsDir` and the `.noir/sdd/` phantom is gone from every skill body.
- [ ] `validateSkill` returns `ok:false` for any skill body naming a non-canonical `.noir/` path; `lintSkill` warns (not fails) on missing S4 sections.
- [ ] `noir skills lint` passes over all 26 builtins after the S7 corrections.
- [ ] `docs/reference/artifact-format.md` + `docs/decisions/0007-*.md` exist and the reference is linked from the skills docs.
- [ ] Full gate green: `pnpm lint → build → typecheck → test → docs:validate`; existing artifact tests updated to the new names, no regression.

## Constraints

- **Single source of truth** — the `ARTIFACT_TYPES` registry is the only place codes/dirs/extensions are defined; gate and writers read it.
- **Single writer** — `nextArtifactSequence` scan is safe because the daemon is the single store writer; the artifact writers run in one process per operation.
- **No store schema change** — sequencing is scan-based (like the existing ADR scan), not a stored counter.
- **Forward-only** — existing `.noir/` files keep their names and keep working (readers key off `id`/`kind`, never filename); no migration, no rename of user files.
- **Additive frontmatter** — no field that existing readers require is removed or renamed.
- **Keep the proven hygiene** — managed-block no-clobber, preserve-on-conflict, append-only CHANGELOG, ISO dates are untouched.
- **`.noir/`-only scope** — repo `docs/internal` + `docs/decisions` stay on the human-authored convention (two standards, explicitly permitted).

## Open questions

None — resolved by design discussion (scope = `.noir/`; type codes 2-letter + acronyms; per-type NNNN; token order `CODE-NNNN-taskId-slug`; `ADR-NNNN-slug`; all 12 types; gate hard + lint soft).
