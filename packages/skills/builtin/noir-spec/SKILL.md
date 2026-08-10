---
name: noir-spec
description: Use when turning a brainstormed idea into a formal spec — capturing the what, why, acceptance criteria, and non-goals. Use when the user says "write a spec" or "spec this". Do NOT use for a single-line feature request that needs no formalization.
argument-hint: <the idea or feature to specify>
metadata:
  category: spec
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-spec

Turn a brainstormed idea into a formal specification — the contract the implementation plan builds against. The spec captures what to build and why, not how to build it. Keep it focused; a spec is a reference, not a novel.

**Invoked with:** `$ARGUMENTS` (optional). If present, treat it as the starting idea. If empty, ask what to specify.

## When to use

- A brainstorm session has produced a clear direction and it's time to formalize.
- The user says "write a spec", "spec this", "formalize this", or "create a specification".
- A feature is large enough that the what/why/non-goals deserve a written reference before planning.
- **Do NOT use:** for a trivial single-file change that needs no contract.

## Procedure

1. **Restate the goal** (one sentence — what are we building and why).
2. **Capture the scope.** What's in, what's explicitly out (non-goals), and who this is for (users / personas). On Claude Code, use `AskUserQuestion` for structured choices; on other hosts, ask in plain text.
3. **Define acceptance criteria.** Concrete, verifiable "done when" statements. No vague acceptances.
4. **Note constraints.** Technical, timeline, dependency, or architectural constraints that bind the implementation.
5. **Write to `.noir/specs/<id>-<slug>.md`.** Use the spec template at `references/spec-template.md` if shipped. The file is the durable contract; the engine records the spec checkpoint.
6. **Hand off.** Point to `noir-planning` to break this spec into an implementation plan.

## Verification

- [ ] The goal is one clear sentence.
- [ ] Scope boundaries (in / out) are explicit — no "we'll figure it out later."
- [ ] Acceptance criteria are concrete and verifiable (numbers, behaviors, screens).
- [ ] Non-goals are listed (what we are deliberately NOT building).
- [ ] The spec stub is written to `.noir/specs/` (or surfaced to the user if not initialized).

## Notes

- A spec can be short. A 10-line spec with sharp boundaries beats a 200-line essay with fuzzy acceptances.
- Reference sibling specs when a feature builds on one — don't copy-paste.
- If the user already has a clear mental model, don't force a spec; ask whether they'd like one.

## When done → next skill

→ `noir-planning` to break the spec into an implementation plan. Or is there something else you'd like to do?
