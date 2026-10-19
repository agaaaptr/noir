---
name: noir-subagent
description: Use when dispatching independent implementation tasks as fresh subagents — one task per subagent with review between. Use when the user says "use subagents" or "dispatch these". Do NOT use for sequential tasks that share state; use noir-executing-plans instead.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - dispatch-guide.md
---

# noir-subagent

Dispatch each independent task to a fresh subagent with a brief, then review the result. Parallel execution with review gates — the fastest path through a fan-out plan.

## When to use

- An implementation plan has independent tasks (no shared state, no ordering).
- The user says "use subagents", "dispatch these", or "run them in parallel."
- **Do NOT use:** for sequential tasks (task B reads task A's output) — use `noir-executing-plans`. For general concurrent work without per-task review, use `noir-parallel`.

## Procedure

### Pre-flight
1. **Write a brief per task.** Each subagent gets: the task goal, the files it touches, the expected output, and a deadline. The brief lives at `.noir/subagents/BR-<NNNN>-<slug>.md`.
2. **Validate independence.** If task B needs task A's output, they're not independent — order them or merge them.

### Per task
3. **Dispatch the subagent.** Fresh subagent, clean context, reads the brief and the spec. On Claude Code, use the `Task` tool with a specific subagent type (e.g. `Explore` for search, `Plan` for design) — or use `Agent` with `subagent_type` for custom configurations. On other hosts, dispatch whatever agent/subagent runner is available. **Issue multiple dispatches in ONE response to run them concurrently.**
4. **Receive the report.** The subagent returns a `.noir/subagents/RP-<NNNN>-<slug>.md` — what was done, test results, any issues.
5. **Review.** Verify: tests pass, spec satisfied, commits are clean. If not, return to the subagent with the specific issues — don't rewrite their code yourself (that defeats the isolation). If a task needs rework, re-dispatch with the issues as context.

### Final
6. **Integrate.** All tasks done, all tests green, all briefs archived. Hand off to `noir-verifying`.

## Reference

For brief-writing, independence validation, and review mechanics, see [dispatch-guide.md](references/dispatch-guide.md).

## When done → next skill

→ `noir-verifying` for the full integration gate, then `noir-shipping`.

## Notes
- This skill is a playbook — the host decides which tools to use.
