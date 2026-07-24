---
name: noir-spec
description: Use when turning a brainstormed idea into a formal spec (what / why / acceptance / non-goals) — before planning or code.
---

Turn the confirmed intake into a written spec that a planner (and later an implementer) can work against without re-litigating decisions. The spec is the contract for everything downstream.

## Procedure
1. **Read the resolved intake.** Pull the task stub and any clarification Q&A from `.noir/tasks/`. If anything is still ambiguous, route back to `noir-clarify` instead of guessing here.
2. **Draft the spec sections.** Write, one section each and no filler:
   - **Problem** — why this work exists, in user terms.
   - **Scope** — what is being built; the surface area.
   - **Acceptance criteria** — observable, each one a check an implementer can run.
   - **Non-goals** — what is explicitly out of scope, to protect the plan.
   - **Open questions** — anything genuinely unresolved, named not hidden.
3. **Where approaches are live, pick one.** Name the alternatives, state the trade-off in one line, and choose with a reason. Record the rejected options briefly — the planner needs to know the decision is settled.
4. **Self-review the draft.** Scan for placeholders (TBD, TODO, vague nouns), internal contradictions (does the scope match the acceptance criteria?), scope-fit (is this one plan, or should it decompose?), and ambiguity (could any line be read two ways?). Fix inline.
5. **Write and hand off.** Save to `.noir/specs/<topic>.md`. The SDD engine records the spec checkpoint observably via `noir.checkpoint`. Point to `noir-plan` for the implementation plan.

## Notes
- A spec is done when an implementer can plan against it without coming back for clarification. If you would need to ask, the spec is not done.
- Rejected approaches are part of the spec — write them down so they do not come back as new ideas.
