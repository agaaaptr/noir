---
name: noir-over-engineering-review
description: Use when the user says "review for over-engineering", "what can we delete", "is this over-engineered", or "simplify". Review the current diff for reinvented stdlib, unneeded dependencies, speculative abstractions, and dead flexibility, one line per finding. Do NOT use for a correctness or security review (noir-verifying or noir-security), a read-only search (noir-exploring), or a whole-repo audit (noir-codebase-audit).
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-over-engineering-review

Review the current diff for complexity that does not earn its place: code that reimplements the standard library, dependencies pulled in for what a few lines would cover, abstractions with one caller, and flexibility nothing uses. Report one line per finding so each can be cut on the spot.

## When to use

- The user says "review for over-engineering", "what can we delete", "is this over-engineered", or "simplify".
- A diff has grown and the reviewer wants a deletion-first pass before the correctness pass.
- **Do NOT use** for a correctness or security review (`noir-verifying`, `noir-security`), a read-only codebase search (`noir-exploring`), or the whole-repo audit (`noir-codebase-audit`).

## Procedure

1. **Read the diff, not the file.** Scope findings to lines the change adds or touches. Existing complexity is out of scope unless the change depends on it.
2. **Run the four checks in order:** reinvented stdlib, unneeded dependency, speculative abstraction, dead flexibility.
3. **Write one line per finding.** Name the location, what to cut, and what replaces it. For example: `src/parse.ts:12 hand-rolled slug regex; replace with the slug helper in src/text.ts`.
4. **Stop at deletion.** When the fix is "delete the thing", write that and move on. A finding that needs a paragraph to justify is not ready to cut today.

## Verification

- [ ] Every finding names a location, the thing to cut, and what replaces it.
- [ ] Findings cover only lines the diff adds or touches.
- [ ] No finding is a correctness bug; those go to `noir-verifying`.
- [ ] Each finding is one line; anything longer was rewritten to fit.

## Notes

- Deletion over rewriting: a wrapper that adds nothing gets deleted, not described.
- A factory for one product, an interface with one implementation, a config knob nobody turns: all delete.
- Report the highest-value cuts first; the reader may stop after the first three.

## When done → next skill

→ `noir-verifying` to confirm the deletions left the behavior intact. Or `noir-codebase-audit` for the whole-repo pass.
