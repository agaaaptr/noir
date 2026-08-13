# ADR-0007: C3 generated-artifact standard — type codes, frontmatter, per-type outlines

- **Status:** Accepted
- **Date:** 2026-08-13

## Context

C3 (Built-in Skill System) ships 26 `noir-` skills, many of which tell the host to **generate a file** (spec, plan, PRD, task, analysis, decision record, bug report, subagent brief/report, handoff, intake, clarification). An audit found **29 file-generating surfaces** with three conflicting naming families and no shared contract:

1. **Naming drift** — the engine writes `.noir/specs/<taskId>-<slug>.md`, but `noir-planning` prescribes `.noir/plans/<date>-<slug>.md`, `noir-spec` prescribes `.noir/specs/<id>-<slug>.md`, and `noir-subagent` invents `.noir/sdd/task-N-brief.md` (a directory absent from `layout.ts`).
2. **No frontmatter / no provenance** — generated and hand-authored files are indistinguishable; the decision stub carries status as an HTML comment (`<!-- Status: pending -->`).
3. **Divergent templates** — only spec and PRD have skeletons; PRD itself diverges (skill 6 sections vs `draftPrd` 9).
4. **Two ADR homes** — `.noir/decisions/<NNNN>.md` (no slug, comment status) vs repo `docs/decisions/<NNNN>-<slug>.md`.
5. **The gate never sees the output** — `validateSkill`/`lintSkill` validate only the skill files, so output drift escapes CI.

Web research (≥5 sources per dimension, compared) grounded the design: naming (RFC 7322, Nygard ADR numbering, MADR `NNNN-title-with-dashes.md`, adr-tools, ISO-8601 date prefix, kebab-case slugs, Diátaxis type-directories); frontmatter (Jekyll/Pandoc/Obsidian, JSON-Schema validation, MADR status lifecycle, `generated_by`/`generated_at` provenance); doc formats (Google design doc, Rust RFC, OpenSpec GIVEN/WHEN/THEN, Shape Up pitch, PromptKit plan, Amazon PR/FAQ, Nygard/MADR ADR).

## Decision

Adopt one standard, scoped to **`.noir/` generated artifacts** (repo `docs/internal`/`docs/decisions` keep their convention — two standards, explicitly permitted):

1. **Naming** — `<CODE>-<NNNN>-<taskId>-<slug>.md`, where `CODE` is a 2-letter type code (or the acronyms `PRD`/`ADR`) and `NNNN` is a **per-type**, zero-padded, scan-based monotonic sequence (never reused). A 12-kind registry lives in `packages/core/src/artifacts.ts` (`ARTIFACT_TYPES`) as the single source of truth; the writers and the gate both read it.
2. **Frontmatter** — required `kind`/`id`/`slug`/`title`/`status`/`date`/`generated_by`/`generated_at` (+ optional `version`/`author`/`tags`/`related`/`supersedes`/`source`/`checksum`). Status is a real enum, not an HTML comment.
3. **Per-type outlines** — full outlines for SPEC/PLAN/TASK/ANALYSIS/ADR; PRD reconciled to the richer `draftPrd` 9-section set (the skill now matches); light outlines for bug/brief/report/handoff/intake/clarification.
4. **Enforcement** — the C3 gate gains `artifactPathDrift` (hard error on `.noir/` path/naming drift; soft warning on section omissions). Invariant: **filename code == frontmatter `kind` == directory**.
5. **Forward-only** — no store schema change, no migration; readers key off `id`/`kind`, never the filename. Existing `.noir/` files keep working.

## Consequences

- **Positive** — files are self-identifying (type, order, subject readable from the name); generated files carry provenance; the gate mechanically catches drift instead of relying on convention.
- **Negative** — filenames are longer and the type code is redundant with the directory (accepted: the value is at-a-glance readability outside directory context + the enforceable invariant). Rewriting an artifact requires a scan to reuse its sequence (small cost, `findArtifact`).
- **Neutral** — `draftPrd`'s 9-section PRD becomes canonical (the skill's former 6 sections were a subset); `ADR-<NNNN>-<slug>.md` replaces the bare `<NNNN>.md` decision stub.

## References

- [`docs/reference/artifact-format.md`](../reference/artifact-format.md)
- [`docs/internal/specs/2026-08-13-c3-generated-artifact-standard-design.md`](../internal/specs/2026-08-13-c3-generated-artifact-standard-design.md)
