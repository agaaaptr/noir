---
name: noir-executing-plans
description: Use when you have a written implementation plan and are ready to code — drive it task by task with a disciplined implement-test-commit loop. Use when the user says "implement this" or "start building". Do NOT use when there is no plan; run noir-planning first.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-executing-plans

Drive a written implementation plan task by task, in order. Each task: implement → test → commit. One task at a time; each commit is a checkpoint.

## When to use

- A plan is written and it's time to code.
- The user says "implement this", "start coding", "build it", or points at a plan file.
- The plan has ordered tasks — you're executing them sequentially.
- **Do NOT use:** for exploratory coding without a plan; use `noir-brainstorming` first. For independent tasks that can fan out concurrently, use `noir-parallel`. For a single subagent per task with review between, use `noir-subagent`.

## Procedure

1. **Load the plan.** Read the plan file. Confirm the task order. If a task depends on an earlier one, start there.
2. **One task at a time.** Pick the next pending task. State which task you're executing. Do not bundle multiple tasks into one commit.
3. **RED → GREEN → COMMIT.** Write the failing test first (see `noir-test-driven-development`), implement the minimal code to pass, verify the test goes green and no regression, then commit with a conventional-commit message. Repeat for the task's subtasks if any.
4. **Mark the task done.** Update the plan's checkbox `- [x]` and move to the next task. The engine's execute gate records the checkpoint observably.
5. **When the plan is done:** all tasks ticked, all tests green, the implementation matches the spec → hand off.

## Verification

- [ ] Every task in the plan is implemented, tested, and committed.
- [ ] No regression in the existing test suite.
- [ ] The implementation fulfills every acceptance criterion from the spec.
- [ ] No "while I'm here" refactors crept into task commits (each commit is one task).

## Notes

- Don't skip tests because "the change is simple." A simple change that breaks silently is the most expensive bug.
- If a task reveals that the plan is wrong, stop and update the plan — `noir-planning` for the revised scope, then resume.
- Commit per task, not per file. A task = one logical change = one commit.

## When done → next skill

→ `noir-verifying` to prove the work is complete. Or is there another task you'd like to handle?
