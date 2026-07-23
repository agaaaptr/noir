# Doc-Structure Standard

One documentation layout for every project — set up by `/init`, curated by `/wrap`. Derived from two real `tidy-session-docs` references (BE `svc-academic-activity-go`; FE `lib-uii-gateway-academy-angular`) unified into a single standard so every project looks the same.

## Permanent (committed, keep — never delete)
- `docs/specs/` — design specs (`YYYY-MM-DD-<topic>.md`)
- `docs/plans/` — implementation plans (**kept as records**)
- `docs/decisions/` — ADRs (`NNNN-<slug>.md`)
- `docs/architecture/` — architecture overviews
- `docs/reference/` — durable reference (DB, conventions, handbook); includes `project-memory.md` (the `/init` memory-recall doc)
- `docs/handoffs/` — cross-team (BE↔FE) handoffs
- `docs/findings/` — validation / incident records
- `docs/DOC-POLICY.md` — declares this classification + naming + red-flags
- root `README.md` / `CHANGELOG.md` / `CLAUDE.md` / `AGENTS.md` — project-root anchors (keep)

## Ephemeral (gitignored, promote-or-delete each session — only durable survives)
- `.session/` — neutral session scratch.
- `.superpowers/sdd/` — SDD default scratch (not overrideable); **contents cleaned each session end**.

## Naming
`YYYY-MM-DD-<scope>-<slug>.md` (scope = module/team, e.g. `nonclass`, `fe`, `db`).

## superpowers override (committed docs)
specs → `docs/specs/`, plans → `docs/plans/` (declared as a preference in `AGENTS.md`/`CLAUDE.md`). Prevents stray `docs/superpowers/`.

## Curation rules (for `/wrap`)
- Permanent = keep.
- Ephemeral = promote durable content → permanent, then delete the rest.
- Stale / inaccurate permanent → fix or delete (don't keep garbage).
- Sole record of a non-obvious decision → promote to `decisions/`, never delete.

## `/init` scan behavior
When `/init` scans the project + docs and finds an **existing doc structure or similar docs**, ASK the user: (a) adapt the existing to this standard, or (b) leave existing as-is and generate the standard docs alongside. noir-workflow standard docs are **always generated**; the fate of existing docs is the user's call (move / leave).

## DOC-POLICY.md template

```markdown
# DOC-POLICY

## Permanent — NEVER delete
- docs/specs/*, docs/plans/*, docs/decisions/*, docs/architecture/*, docs/reference/*, docs/handoffs/*, docs/findings/*
- docs/DOC-POLICY.md, README.md, CHANGELOG.md

## Transient — prune each session
- .session/*, .superpowers/sdd/*
- any scratch not matching a permanent pattern

## Red flags — STOP
- About to rm something under specs/ plans/ decisions/ reference/ → permanent, don't.
- About to delete without showing the user a list first → stop, show the list.
- User said "clean everything" → still show the permanent list as "kept".
```
