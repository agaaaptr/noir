---
name: noir-clarify
description: Use when an idea or spec has ambiguities — to surface and resolve open questions before committing to an approach.
---

Resolve every open question and assumption into a confirmed shared understanding before any planning or code. This is the gate that prevents the rest of the lifecycle from building on a guess.

## Procedure
1. **Collect the ambiguities.** Read the task stub under `.noir/tasks/` (or the draft spec under `.noir/specs/`). List every assumption you would otherwise carry forward as an explicit open question. Add the ones the intake phase flagged.
2. **Resolve in a focused batch.** Put the questions to the user in one round, grouped by theme — not a wall of one-by-one prompts. Record each Q&A pair verbatim in the task stub.
3. **State the shared understanding.** Print a concise *My understanding* summary: the task, the chosen approach, the files/modules it touches, and the conventions it honors. Keep it short enough that the user can actually review it.
4. **Wait for confirmation.** Do not proceed past this gate until the user confirms. The SDD engine records the clarify checkpoint observably via `noir.checkpoint` — confirmation is recorded, not asserted by you.
5. **Route forward.** With the gate cleared, hand to `noir-spec` to formalize, or directly to `noir-plan` if a spec already exists. On later doubt mid-build, return here rather than improvising.

## Notes
- One confirmed answer is worth ten inferred ones. If a question cannot be resolved, leave it open and say so — do not pick a default and proceed.
- The gate is procedural, not rhetorical: state the understanding, get confirmation, let the engine record it.
