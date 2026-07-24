---
name: noir-intake
description: Use when starting a new feature or task from a raw idea, ticket, or issue — before any design or code.
---

Capture a raw request as a grounded task stub before any design or implementation. The job here is to record what is actually known and flag what is not — not to solve, design, or paraphrase ambiguity away.

## Procedure
1. **Capture the raw input.** Take the idea, ticket, or issue text as-is. Quote the originating words; do not silently summarize. If the source is a paste, keep the paste.
2. **Ground in project context.** Read `CLAUDE.md` / `AGENTS.md`, recent commits, and any neighbor spec under `.noir/specs/`. Note which existing module or package this request most likely touches — as a hypothesis, not a decision.
3. **Draft the task stub.** Write `.noir/tasks/<id>.md` with: problem statement (in the user's words), rough acceptance criteria (observable, not vague), likely touch points, and an explicit *Open questions* list. Every blank becomes an open question — never an assumption.
4. **Start the SDD task.** Call `noir.workflow_status` to confirm the task is at the `intake` phase. The engine records the intake checkpoint observably via `noir.checkpoint`; you do not need to assert it.
5. **Hand off.** Point to `noir-clarify` to resolve the open questions. Do not design, plan, or code in this phase.

## Notes
- Intake is a recording step, not a solution step. If you cannot tell whether something is a requirement, write it as an open question.
- Do not invent acceptance criteria to fill blanks — surface them. `noir-clarify` exists to close them.
