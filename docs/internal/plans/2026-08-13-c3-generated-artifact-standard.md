# C3 Generated Artifact Standard — implementation plan

> Implements [`2026-08-13-c3-generated-artifact-standard-design.md`](../specs/2026-08-13-c3-generated-artifact-standard-design.md). Pure additive + drift-correction; no store schema change, forward-only naming, `.noir/`-scoped.

## Implementation order (dependency-driven)

1. **P1 — Registry foundation** — `packages/core/src/artifacts.ts`: `ARTIFACT_TYPES` (12 kinds + `artifactFileName` + `nextArtifactSequence`). Export from `@noir-ai/core`. *Blocks everything below.*
2. **P2 — Layout** — `packages/core/src/layout.ts`: add `analysisDir`/`bugsDir`/`subagentsDir`; change `specFile`/`planFile`/`prdFile`/`taskFile`/`decisionFile` (and any handoff/intake builders) to delegate to `artifactFileName` (new `nnnn`/`slug` args).
3. **P3 — Writers** — `packages/workflow/src/artifacts.ts`: each `.md` writer computes `nnnn` + emits full frontmatter; `writeDecisionStub` → `ADR-NNNN-slug` + `status: proposed`. `packages/cli/src/commands/task.ts` `writeDoneArtifacts` uses `nextArtifactSequence(root,'adr')` + real slug.
4. **P4 — PRD canon** — `packages/model/src/draft.ts`: 9 sections → the 6-section canonical PRD (fix the "they mirror" comment).
5. **P5 — Gate** — `packages/skills/src/quality.ts`: `artifactPathDrift()` cross-checking skill bodies against `ARTIFACT_TYPES`; wire into `validateSkill` (hard) + `lintSkill` (soft section warning).
6. **P6 — Skill fixes** — edit builtins that name non-canonical `.noir/` paths: `noir-planning`, `noir-subagent`, `noir-spec`, `noir-prd`, `noir-brainstorming`, `noir-rules`, `noir-wrap`, `noir-writing-skills`.
7. **P7 — Docs** — `docs/reference/artifact-format.md` + `docs/decisions/0007-generated-artifact-standard.md`; link from skills docs.
8. **P8 — Tests + gate** — update existing artifact/compiler/hygiene tests to the new names; add gate drift test; run full gate.

## Affected files

- **core** `src/artifacts.ts` (new), `src/layout.ts`, `src/index.ts` (export)
- **workflow** `src/artifacts.ts`
- **cli** `src/commands/task.ts`
- **model** `src/draft.ts`
- **skills** `src/quality.ts`, `builtin/{noir-planning,noir-subagent,noir-spec,noir-prd,noir-brainstorming,noir-rules,noir-wrap,noir-writing-skills}/SKILL.md` (+ `noir-spec/references/spec-template.md`, `noir-subagent/references/dispatch-guide.md`)
- **tests** `skills/test/compiler.test.ts`, `skills/test/builtin-hygiene.test.ts`, `workflow/test/*`, `model/test/*`, any test asserting `.noir/…` filenames or frontmatter
- **docs** `reference/artifact-format.md` (new), `decisions/0007-*.md` (new), `roadmap/STATUS.md` + `backlog.md` + `manifest.yaml` (C3 note)

## Testing strategy

- Unit: `nextArtifactSequence` per-type independence + zero-pad + max+1; `artifactFileName` for every kind (with/without taskId/slug); `artifactPathDrift` positive/negative.
- Gate: a skill body quoting `.noir/plans/<date>` fails `validateSkill`; quoting `PL-…` passes.
- Writer: each writer emits `CODE-NNNN-…` name + required frontmatter; decision stub emits `status: proposed` (no HTML comment).
- Regression: full gate green; existing offline suite never requires network.

## Rollback

- All changes are additive or drift-fixes; revert = `git revert` the checkpoint commit. No data migration (filenames are derived, store keys unchanged), so a revert leaves user projects intact.

## Docs to update at the same checkpoint

- `docs/reference/artifact-format.md` (new standard) · `docs/decisions/0007-*.md` · `docs/roadmap/STATUS.md` (C3 note) · `CHANGELOG.md` (next release) · any `docs/` that quotes the old `.noir/specs/<taskId>-<slug>.md` form.
