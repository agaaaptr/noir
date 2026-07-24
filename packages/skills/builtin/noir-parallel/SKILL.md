---
name: noir-parallel
description: Use when facing two or more independent tasks with no shared state or ordering — to work them concurrently.
---

Dispatch one focused subagent per independent problem and let them run concurrently. Each subagent gets precisely crafted scope and context — never the controller's session history — so it stays narrow and you preserve your own context for coordination. Sequential investigation of independent problems wastes wall-clock; parallel dispatch collapses that to the slowest agent.

## Procedure

### 1. Confirm the tasks are genuinely independent
Before dispatching, verify:
- each problem can be understood without context from the others;
- fixing one cannot fix or break another;
- the agents will not edit the same files or contend on the same resource (ports, locks, the working tree).

If the failures are related, or you do not yet know what is broken, do not parallelize — investigate together first. Shared state and exploratory debugging disqualify this skill.

### 2. Group by independent domain
Cluster the work by what is actually broken or what is actually being built: one test file or subsystem per agent. "Fix all the tests" is too broad; "fix the 3 failing tests in `agent-tool-abort.test.ts`" is a domain.

### 3. Craft each task
Each dispatch carries:
- **Scope** — the exact file(s) or subsystem; name them.
- **Goal** — what "done" looks like (tests green, function added with signature X).
- **Context** — the error messages, test names, or interface contract the agent needs. Do not make it re-derive what you already know.
- **Constraints** — what it must not touch ("production code", "other test files"), and any anti-patterns to refuse ("do not just raise the timeout — find the real issue").
- **Output** — what to return (a summary of root cause and the change made, plus the test evidence).

### 4. Dispatch in parallel
Issue every subagent dispatch in the same response — multiple dispatches in one response run concurrently, one per response runs sequentially. This is the move that buys the time saving.

### 5. Review and integrate
When the agents return:
- read each summary;
- check the diffs for conflicts — did two agents edit the same code?;
- run the full suite (not just each agent's scoped tests) to verify the fixes compose;
- spot-check the changes — a subagent can make a systematic error that its own scoped tests do not catch.

If two agents touched overlapping code, reconcile manually and re-run before claiming green.

## When not to use
- The failures are related — fixing one might fix or break another.
- Understanding requires seeing the whole system at once.
- The work is exploratory — you do not yet know what is broken.
- Agents would contend (editing the same files, binding the same port, taking the same lock).

## Notes
- Parallel dispatch trades coordination cost for wall-clock. For two small tasks, the overhead of crafting two briefs may not be worth it — sequential is fine. The win compounds at three or more independent domains.
- Each agent's report is its deliverable; the controller's job at the end is integration and the full-suite check, not re-doing the investigation.
- Discipline is observable, not rhetorical: the SDD engine records the parallel dispatch and its integrated result via `noir.checkpoint` (the SDD execute gate).
