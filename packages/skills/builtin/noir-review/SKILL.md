---
name: noir-review
description: Use when completing a task or before merging — to verify the work meets its requirements.
---

Run a real review on completed work before claiming it done. This skill covers both halves: requesting a review with precisely crafted context, and receiving review feedback with technical rigor rather than performative agreement. The reviewer gets the work product, never your session's reasoning history.

## Procedure

### Requesting a review
1. **Scope the diff.** Capture `BASE_SHA` (the commit the work started from — never `HEAD~1`, which silently truncates a multi-commit task) and `HEAD_SHA`. Write a one-line description of what was built and a pointer to the plan or requirements it must satisfy.
2. **Dispatch a reviewer with crafted context, not session history.** Hand the reviewer: the description, the plan-or-requirements pointer, the BASE/HEAD shas, and the diff as a file (e.g. `git diff <BASE> <HEAD> -U10 > .noir/reviews/<task>-diff.patch`). A fresh reviewer seeing only the work product stays focused and preserves your context for continued work.
3. **Triage findings by severity.** Fix Critical issues immediately, fix Important issues before moving on, and record Minor issues for the final whole-branch pass. Do not batch them all into one fix run.
4. **Push back when the reviewer is wrong.** If a finding is technically incorrect for this codebase, lacks context, or violates an accepted decision, respond with technical reasoning — working tests, code that proves the existing behavior, or the spec line that mandates the current shape. Do not implement a suggestion just because a reviewer raised it.

### Receiving feedback
5. **Read, then verify — do not react.** Restate the requirement in your own words (or ask for clarification) before implementing. Check each item against the codebase: is it technically correct here, does it break existing behavior, does it conflict with a prior decision?
6. **Clarify unclear items as a batch.** If part of a multi-item review is unclear, stop and ask about every unclear item before implementing any of them — items are often related, and partial understanding produces wrong implementation.
7. **YAGNI-check "implement it properly" suggestions.** Before adding a suggested abstraction or endpoint, grep the codebase for actual usage. If nothing calls it, propose removal before proposing the proper version.
8. **Acknowledge correct feedback quietly.** State the fix ("Fixed: extracted the magic number to `PROGRESS_INTERVAL`"). No performative agreement, no thanks — the code itself is the acknowledgment.

### Close the loop
9. **Record the review.** Capture the verdict, the findings acted on, and any deferred Minor items via `noir.checkpoint` (the SDD verify gate). For the final whole-branch review, point `MERGE_BASE = git merge-base main HEAD` so the reviewer sees the entire branch.

## Notes
- External feedback is a suggestion to evaluate, not an order to follow. Verify, question, then implement.
- The reviewer and the implementer both report to the work's requirements. If a suggestion violates the spec or adds unused surface area, the answer is evidence-based pushback, not compliance.
- Discipline is observable, not rhetorical: the SDD engine records that the verify gate ran, with the diff and verdict attached.
