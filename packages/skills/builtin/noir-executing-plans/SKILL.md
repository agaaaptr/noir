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
- **This skill routes to the right execution mode** — inline (sequential), subagent-driven, combination, or workflow orchestration — based on what the user chooses.
- **Do NOT use:** for exploratory coding without a plan; use `noir-brainstorming` first.

## Procedure

1. **Load the plan.** Read the plan file. Confirm the task order. If a task depends on an earlier one, start there.
2. **Offer execution mode.** On Claude Code, use `AskUserQuestion` to let the user choose how to execute. On other hosts, ask in plain text. The options (presented as a structured choice):

   | Mode | Best for | What happens |
   |---|---|---|
   | **Inline (sequential)** | Ordered tasks with dependencies, small-to-medium scope | Drive tasks one-by-one in this session — implement, test, commit, move to next. You stay in control. |
   | **Subagent-driven** | Independent tasks, fan-out plans, need per-task review | Hand off to `noir-subagent` — dispatch fresh subagent per task with briefs and review gates. |
   | **Combination** | Mix of sequential + independent tasks | Start inline for dependency-chain tasks, then fan out independent ones via subagents. |
   | **Workflow orchestration** | Large plans, "ultracode" active, multi-agent parallelism | Use the host's Workflow tool to orchestrate many agents concurrently with review between stages. Only offered when the host's effort/capability level supports it. |

   **Default:** if the user doesn't choose, use inline (sequential) — it's the safest, most reviewable path.

3. **Execute in the chosen mode.** Follow the mode-specific flow:
   - **Inline:** pick the next pending task → state it → RED (failing test) → GREEN (minimal impl) → REFACTOR → commit → mark `[x]` → repeat.
   - **Subagent-driven:** route to `noir-subagent` (it handles briefs, dispatch, review, integration).
   - **Combination:** execute dependency-chain tasks inline first, then fan out independent ones.
   - **Workflow:** compose the workflow script (phases, agents, review gates) from the plan, then dispatch.
4. **Mark progress.** Update the plan's checkboxes `- [x]` as tasks complete. The engine's execute gate records checkpoints observably.
5. **When the plan is done:** all tasks ticked, all tests green, the implementation matches the spec → hand off to `noir-verifying`.

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
