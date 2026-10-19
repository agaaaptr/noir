---
name: noir-parallel
description: Use when facing two or more independent tasks — dispatch them concurrently without blocking each other. Use when the user says "do these at the same time" or "work on both". Do NOT use for tasks that share state or have ordering; use noir-executing-plans or noir-subagent instead.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-parallel

When two or more tasks are independent (no shared state, no ordering), work them concurrently. Every tool dispatch in one response — no waiting for Task A to finish before starting Task B.

## When to use

- 2+ tasks that don't depend on each other.
- The user says "do these at the same time", "concurrently", "parallelize."
- A task naturally splits into non-overlapping sub-tasks.
- **Do NOT use:** when tasks share state (B reads A's output). For a fan-out plan with review between tasks, use `noir-subagent`.

## Procedure

1. **Validate independence.** List the tasks. Confirm none reads another's output or touches the same file in a conflicting way.
2. **Dispatch all tasks in ONE response.** On Claude Code, issue multiple `Task` tool calls or `Agent` dispatches in the same message turn — the host runs them concurrently. On other hosts, use whatever parallel dispatch mechanism is available (subagents, parallel tool calls, async workers). The key: don't wait for Task A's full completion before starting Task B — issue them together.
3. **Collect results.** Each result lands independently. Aggregate, then continue. If any task failed or needs adjustment, route it to `noir-systematic-debugging` before integrating.
4. **Integrate.** All results clean → combine and proceed.

## When not to use

- Shared database or shared file writes — these must be sequential or protected by locking.
- Tasks with a dependency chain — use `noir-executing-plans`.
- Tasks that need per-task review — use `noir-subagent`.

## When done → next skill

→ `noir-verifying` to confirm all tasks are done and integrated.

## Notes
- This skill is a playbook — the host decides which tools to use.
