# Capability 7 — Engineering Governance & Project Operating System

> **Status:** Shipped core — ADRs, SDD process, CI gates, release governance live; tech-debt registry is research

## Overview

The governance ruleset that makes Noir a "project operating system": an ADR series for architectural decisions, a spec-driven development process, CI quality gates on every change, release governance with provenance, docs governance that validates and regenerates reference content, and skill/toolchain governance rooted in `AGENTS.md`. This is the discipline layer that ties the other capabilities into one auditable system.

## Shipped today

- **ADR series established** — ADR-0001..0004 plus an index `docs/decisions/README.md` with an append-only convention: superseded ADRs are marked, never deleted.
- **Spec-driven process dogfooded** — 16 dated design specs under `docs/internal/specs/` and 17 dated implementation plans + acceptance checklists under `docs/internal/plans/`.
- **CI quality gates on every push/PR** — `.github/workflows/ci.yml` runs Biome lint, build, typecheck, Vitest tests, and `docs:validate` on ubuntu + macos with Node 22.
- **Release governance shipped and used** — `.github/workflows/release.yml`: unified versioning, version-string channels, SLSA provenance, idempotent publish.
- **Docs governance** — `docs:validate` broken-link/stale-version checks; `docs:generate` auto-writes reference docs and managed blocks (package.json scripts).
- **Root `AGENTS.md` governance** — immutable toolchain contract, Conventional Commits, local-only commits, privacy/provider-explicit rules, plus the SDD workflow spec/plan paths.
- **Skill governance** — compiler validation of skills (WHEN-led, `noir-` prefix, dir-equals-name) plus a forbidden-residue guard.
- **Roadmap governance artifacts** — capability docs, ROADMAP.md, STATUS.md, CONTRIBUTING.md, capability manifest, CHANGELOG.

## Gap / roadmap delta

- Root `CONTRIBUTING.md` (code-contribution guide) — added 2026-08 as part of the docs restructure.
- Specification-validation gate in CI — gates currently stop at lint/build/typecheck/test/`docs:validate`.
- Technical-debt registry artifact (identifier / kategori / penyebab / prioritas / estimasi / rencana).
- Engineering/project-health metrics — test coverage, stale-doc automation, release frequency, CI stability.
- Durable checkpoint registry (`docs/checkpoints/` or a manifest entry).
- Migration-guide deliverable + automated rollback path in the release flow.
- Correct stale doc path labels — `AGENTS.md` and ADR-0001 still point SDD specs/plans at nonexistent `docs/internal/` + `docs/internal/specs/`; the real location is `docs/internal/{specs,plans}/`.

## Acceptance criteria

- MET — Any architectural decision is recorded in `docs/decisions/` as an ADR; superseded ADRs are marked, never deleted.
- MET — New slices land only after a dated spec in `docs/internal/specs/` and an implementation plan in `docs/internal/plans/`, with the acceptance checklist closed out.
- MET — Every push/PR passes lint, build, typecheck, tests, and `docs:validate` on ubuntu and macos (Node 22).
- MET — Releases publish idempotently from `.github/workflows/release.yml` with unified versioning and SLSA provenance.
- MET — `docs:generate` runs clean and `docs:validate` reports zero broken links / stale versions.
- GAP — CI runs a spec-validation gate in addition to the current gates.
- GAP — A tech-debt registry exists with every debt entry carrying identifier, category, cause, priority, estimate, and remediation plan.
- GAP — A health report surfaces test coverage, stale-doc count, release frequency, and CI stability.

## References

- `docs/decisions/README.md`
- `docs/decisions/0001-doc-layout-and-spec-plan-paths.md`
- `docs/decisions/0002-native-skills-only-plugin-removed.md`
- `docs/decisions/0003-v1x-capabilities.md`
- `docs/decisions/0004-multi-host-adapters.md`
- `AGENTS.md`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `docs/internal/specs/`
- `docs/internal/plans/`
