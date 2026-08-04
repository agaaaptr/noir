# ADR-0001: Documentation layout and spec/plan paths

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

The repo accumulated flat docs (`docs/<file>.md`) alongside Superpowers-generated `docs/internal/{specs,plans}/`. The result was hard to track and inconsistent with how professional AI-skill repositories organize their documentation.

## Decision

Adopt a typed `docs/` layout: `architecture/`, `decisions/` (ADRs), `findings/`, `specs/`, `plans/`, with a `docs/README.md` index. Design specs and implementation plans are written to `docs/internal/specs/` and `docs/plans/` (dated `YYYY-MM-DD-<topic>.md`), **overriding** the Superpowers default of `docs/internal/`. Local session scratch (`.superpowers/`) is gitignored. Add a root `AGENTS.md` for agent-guided development of the repo itself.

## Consequences

- One predictable home per document type; easier to find and maintain.
- Brainstorming/writing-plans sessions must be told (via `AGENTS.md`) to use `docs/specs` / `docs/plans`. Both skills accept a user-preferred location, so this is supported.
- Future repo-level decisions are recorded in `decisions/` as numbered, append-only ADRs.

## Update (2026-07-25)

The typed-layout intent above stands (`architecture/`, `decisions/`, `findings/`, `specs/`, `plans/` + a `docs/README.md` index), with one refinement learned in practice. The **Superpowers SDD flow's per-slice spec/plan artifacts** — the v1.0 SDD dogfood — live under `docs/internal/{specs,plans}/`, following the SDD skill's own default convention, while `docs/internal/specs/` holds the top-level Noir blueprint (`2026-07-23-noir-toolkit-design.md`).

So the original "specs/plans go to `docs/internal/specs/` + `docs/plans/`, overriding `docs/internal/`" is refined to: **top-level design specs → `docs/internal/specs/`**; **SDD-per-slice specs/plans → `docs/internal/{specs,plans}/`** (the dogfood convention, kept so the SDD skill works unmodified). This preserves the typed top-level layout without fighting the skill's per-slice output path.
