---
name: noir-planning
description: Use when you have an approved spec and need a step-by-step implementation plan — naming files, interfaces, and tasks before touching code. Use when the user says "plan this" or "how should I build this". Do NOT use when the scope is already clear from the spec and the user asked to start coding.
metadata:
  category: plan
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-planning

Break an approved spec into a concrete, step-by-step implementation plan. The plan names files, describes interfaces, and defines an order — so execution is mechanical, not improvisational. A plan is a contract, not a diary entry.

## When to use

- A spec is approved and it's time to plan the build.
- The user says "plan this", "how should I implement this", "break this down."
- The feature has enough moving parts (multiple files, dependencies, or non-trivial logic) that an ordered plan prevents rework.
- **Do NOT use:** when the spec is trivial (one file, one function) and the user already knows the shape.

## Procedure

1. **Read the spec.** Reload the approved specification. Note every acceptance criterion — each one is a task or a test.
2. **Decompose into tasks.** Break the work into the smallest units that carry their own test cycle and are worth a reviewer's gate. Each task names the files it touches and the interface it produces.
3. **Order the tasks by dependency.** Which task must finish before another starts? List the chain.
4. **Define the interfaces.** For each task, state what it consumes (from earlier tasks) and what it produces (for later tasks). Be specific — exact function names, parameter types, file paths.
5. **Write the plan.** Record under `.noir/plans/PL-<NNNN>-<taskId>-<slug>.md`. Use a numbered task list with checkbox syntax (`- [ ]`) so the engine's verify gate can track completion.
6. **Hand off.** Point to `noir-executing-plans` to drive the plan task by task.

## Verification

- [ ] Every acceptance criterion from the spec maps to ≥1 task.
- [ ] Tasks are ordered (no circular dependencies).
- [ ] Each task names the exact files + interfaces it produces.
- [ ] The plan is committed to `.noir/plans/`.

## Notes

- A plan is a scaffold, not a prison. If a task reveals new information during execution, update the plan — don't force it through.
- For a plan that fans out (independent tasks), note which tasks can run in parallel — `noir-parallel` can then dispatch them concurrently.
- Don't pad a plan with "write tests," "run tests," "commit" per task — those are implicit in the execute-test-commit loop.

## When done → next skill

→ `noir-executing-plans` to implement the plan task by task. Or would you like to adjust anything first?
