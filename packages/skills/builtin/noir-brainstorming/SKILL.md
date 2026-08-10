---
name: noir-brainstorming
description: Use when starting a new feature or task from a raw idea, ticket, or issue — explore intent, requirements, and design space before implementation. Do NOT use for single-file edits, typo fixes, or pure refactors.
argument-hint: <describe the feature or idea to explore>
metadata:
  category: discovery
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-brainstorming

Turn a raw idea, ticket, or ambiguous ask into a shared, written understanding of intent — before any plan or code. The goal is a clear problem statement plus the open questions and options, not a shortcut to the first plausible build. This skill replaces the old `noir-intake`, `noir-clarify`, and `noir-brainstorm` skills — one "gather requirements" surface.

**Invoked with:** `$ARGUMENTS` (optional). If the user passed a feature description, treat it as the initial statement of intent and restate it as the goal. If empty, ask what they want to explore first.

## When to use

- A new feature, task, or epic starts from a raw idea, ticket, or issue.
- The user says "let's build X", "I have an idea", "we need a feature", or pastes a vague request.
- An idea or spec has ambiguities that should be surfaced before committing to an approach.
- **Especially when:** the request is one sentence, the requirements are fuzzy, or the user is unsure what they want.
- **Do NOT use:** for a single-line typo fix, a rename, or a mechanical refactor with no design decision.

## Procedure

1. **Restate the goal.** In one sentence, say what the user is trying to achieve and why. If `$ARGUMENTS` was provided, start from it.
2. **Surface requirements with a structured prompt.** Ask the clarifying questions you genuinely need — but batch them, don't pepper one at a time. On Claude Code, use the `AskUserQuestion` tool (question + up to 4 options) so the user picks instead of types; on hosts without it (Gemini/Cursor/Copilot), ask in plain text. Cover scope, constraints, users, non-goals, and any acceptance you can see.
3. **Offer 2-3 distinct approaches.** Present options with explicit trade-offs. Do not collapse to a single path prematurely; the user chooses.
4. **Record the decision.** Capture the chosen direction + open questions as a spec stub under `.noir/specs/` if the project is Noir-initialized. This is observable, not rhetorical — the SDD engine records the brainstorm checkpoint.
5. **Hand off.** Point to `noir-spec` (formalize) → then `noir-planning` (break down).

## Verification

- [ ] The goal is restated in one sentence and the user confirmed it.
- [ ] Open questions are surfaced; ambiguities are resolved or explicitly deferred.
- [ ] 2-3 options with trade-offs were presented (not one path forced).
- [ ] The decision + open questions are recorded (spec stub or note).

## Notes

- Discipline is observable: the SDD engine's gates record that brainstorming happened. This skill is the playbook.
- For a genuinely trivial request (a one-liner with a clear answer), say so and skip the full ritual — brainstorming is for creative or ambiguous work.
- If the user has a strong opinion, follow it; your job is to surface the space, not to win an argument.

## When done → next skill

→ `noir-spec` to formalize the idea into a spec → `noir-planning` to break it into steps. Or, if you'd rather keep exploring a different direction, say so — I'll pivot.
