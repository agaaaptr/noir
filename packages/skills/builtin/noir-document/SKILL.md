---
name: noir-document
description: Use when closing a work session — to update docs, CHANGELOG, decisions, and memory before wrapping up.
---

Close a work session by bringing durable docs, decisions, and memory in line with what actually shipped, then committing per scope. The terminal phase of the SDD lifecycle.

## Procedure
1. **Survey what actually changed.** Run `git status` and `git diff --stat`. List the files touched and the contracts, modules, or behaviors affected. The diff is the source of truth for what docs need updating — not memory of what was intended.
2. **Update durable docs to match.** Write decisions to `.noir/decisions/`, update handoff notes and API/contract docs where they drift, and add a CHANGELOG entry if the project keeps one. State the change in user-observable terms.
3. **Curate ephemeral notes.** Promote anything durable from scratch notes into permanent docs; delete the rest. Confirm the promote/delete list with the user before acting — do not unilaterally delete.
4. **Commit per scope; confirm push.** One conventional commit per logical change; never bundle unrelated work. Confirm with the user before pushing.
5. **Record and report.** Capture the session outcome via `noir.checkpoint` (the SDD engine's document gate — terminal). Report: test result (with evidence from `noir-verify`), docs updated, commits, push status, and any unfinished work.

## Notes
- Documentation tracks the diff, not the plan. If the diff and the plan disagree, document what shipped and flag the gap.
- Memory and decisions are written for the next session, not for this one — keep them concise and factual.
