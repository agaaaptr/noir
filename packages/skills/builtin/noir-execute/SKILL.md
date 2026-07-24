---
name: noir-execute
description: Use when executing a written implementation plan, task by task — driving the SDD execute phase.
---

Execute an approved implementation plan one task at a time, with a review gate between tasks. The plan is the contract; this skill drives it.

## Procedure
1. **Load the plan.** Read the plan file under `.noir/plans/`. If none, stop and point to `noir-plan`.
2. **One task at a time.** Work the tasks in order. For each task: read its files/interfaces, write the failing test, implement minimally, run the test, commit when green.
3. **Review between tasks.** After each task, run typecheck + lint + tests and review the diff before moving on. The SDD engine records the execute-phase checkpoint observably (`noir.checkpoint`).
4. **Stay in scope.** Commit per logical change with a conventional-commit message; never bundle unrelated changes. If you discover missing scope, return to `noir-clarify` / `noir-plan` rather than improvising.
5. **Hand off to verify.** When all tasks are done, point to `noir-verify` before claiming completion.

## Notes
- Discipline is observable, not rhetorical: the SDD engine's gates record that each task was reviewed. This skill is the playbook.
- On doubt mid-execution, return to the plan or clarify — do not guess.
