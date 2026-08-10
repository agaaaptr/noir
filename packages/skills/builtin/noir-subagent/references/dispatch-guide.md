# Subagent dispatch guide — briefs, independence, review

Deep reference for `noir-subagent`. The mechanics of dispatching fresh subagents per task and reviewing between.

## The brief — what a subagent needs

A subagent starts cold. Its brief must be self-contained:

- **Goal** — one sentence: what must be true when done.
- **Files** — the exact files it may touch (and which it must NOT touch).
- **Constraints** — the interface contract it must satisfy (signatures, formats).
- **Acceptance** — how it proves done (tests pass, output shape).
- **Context pointer** — where to read the relevant spec/plan/background (NOT a dump of everything).

A good brief is 5-10 lines. If it needs a paragraph of caveats, the task isn't independent yet.

## Independence validation

Two tasks are independent only if:

- B does not need A's output to start (or you ORDER them: A then B).
- They do not write the same file in conflicting ways.
- They do not share mutable state (a DB, a cache, a port).

If any dependency exists, you have two choices: run them sequentially (`noir-executing-plans`), or merge them into one task. Dispatching dependent tasks in parallel produces merge hell.

## The review step (non-negotiable)

After each subagent returns, REVIEW before integrating:

1. **Tests pass?** Run the suite. Don't trust the subagent's "all green."
2. **Spec satisfied?** The output meets the brief's acceptance criteria.
3. **No collateral?** The subagent didn't touch files outside its brief, didn't leave debug logs, didn't commit garbage.

If any item fails, return the report to the subagent with the specific issue. Do NOT rewrite their code yourself — that defeats the isolation.

## Files as the contract

Subagents communicate through FILES, not conversation. Each task writes:
- `task-N-brief.md` — what it was asked (you write before dispatch).
- `task-N-report.md` — what it did + test results (it writes on return).

These become the integration record and the `noir-wrap` handoff input. Structured outputs (JSON, CSV, markdown tables) beat prose for machine consumption.

## When NOT to dispatch a subagent

- The task is a single small change (a subagent adds more overhead than value).
- The task requires deep conversation context you already hold.
- The task touches the same file as a parallel task.
- The model is simpler than the task warrants — match subagent capability to task difficulty.
