---
name: noir-plan
description: Use when you have an approved spec and need a step-by-step implementation plan — before touching code.
---

Write a step-by-step implementation plan from the approved spec, sized so each task is one reviewable commit. The plan is what `noir-execute` drives; make it complete enough that execution needs no new design decisions.

## Procedure
1. **Read the spec.** Open the approved spec under `.noir/specs/`. Every requirement, acceptance criterion, and non-goal must map to at least one task — if a requirement has no task, add one before you consider the plan done.
2. **Lay out tasks in execution order.** For each task, write:
   - **Files** — exact paths to create and modify (with line ranges where relevant).
   - **Interfaces** — what the task consumes from earlier tasks (exact signatures) and what it produces for later ones (exact names and types). This block is how a neighbor task learns the contract.
   - **Test** — the failing test that proves the task, and the command that runs it.
3. **Right-size each task.** A task is one reviewable commit. Split anything that bundles unrelated changes; merge anything that is just a sub-step of a single change. Prefer bite-sized tasks that can fail and pass independently.
4. **Self-review the plan.** Check spec coverage (point to a task per requirement), placeholder scan (no TBD / TODO / vague "implement the thing"), and type consistency across tasks (a function called `clearLayers()` in Task 3 must still be `clearLayers()` in Task 7). Fix inline.
5. **Write and hand off.** Save to `.noir/plans/<topic>.md`. The SDD engine records the plan checkpoint observably via `noir.checkpoint`. Point to `noir-execute`.

## Notes
- Assume the implementer is a skilled developer with zero context for this codebase. Document the paths, names, and test commands explicitly — no placeholders, no "you know what I mean".
- If you cannot complete a task without a new design decision, the spec is incomplete — route back to `noir-spec` rather than deciding in the plan.
