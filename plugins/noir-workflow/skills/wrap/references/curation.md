# /wrap — Doc curation logic

Curate the docs tree so only durable, accurate content survives. Unified from the BE + FE `tidy-session-docs` references, per plugin `references/doc-structure.md`.

## Classification
- **Permanent (keep — never delete):** `docs/{specs,plans,decisions,architecture,reference,handoffs,findings}/`, `docs/DOC-POLICY.md`, root `README.md` / `CHANGELOG.md` / `CLAUDE.md` / `AGENTS.md`.
- **Ephemeral (promote-or-delete):** `.session/`, `.superpowers/sdd/` (contents), and any scratch not matching a permanent pattern.

## Routine
1. **Inventory.** List this session's new/changed docs (`git status`, `git log --diff-filter=A`) + scan ephemeral dirs for stale files.
2. **Promote durable** from ephemeral → the right permanent subdir, renamed to `YYYY-MM-DD-<scope>-<slug>.md`:
   - cross-team contract / handoff → `docs/handoffs/`
   - non-obvious decision / spec → `docs/decisions/` (or `docs/specs/`)
   - durable reference → `docs/reference/`
3. **Verify accuracy before promoting.** Do not move a stale/inaccurate doc into permanent — fix it in place or delete it.
4. **Delete ephemeral** (`.session/`, `.superpowers/sdd/` contents, scratch): investigation/debug notes, in-progress plans, task lists, temp prompts, stale iterations. Rule of thumb: if the durable knowledge is already in code / git / `API-CONTRACT.md` / a decision, the scratch is deletable.
5. **Enforce naming** on kept files (`YYYY-MM-DD-<scope>-<slug>.md`).
6. **Confirm with the user** the promote/delete list before acting (`AskUserQuestion`); show the permanent list as "kept" so they see what is protected.
7. **Report** counts + paths (recoverable via git).

## Red flags — STOP
- About to `rm` something under a permanent dir → don't.
- About to delete without showing the user a list first → stop, show the list.
- User said "clean everything" → still show the permanent list as "kept".

## Context-aware
- Read `docs/DOC-POLICY.md` (if present) for project-specific permanent/transient rules; honor them when compatible with the standard.
- Clean `.superpowers/sdd/` contents each session (SDD scratch; gitignored).
