---
name: noir-test-driven-development
description: Use when implementing any feature or bugfix — write the failing test first with the RED→GREEN→REFACTOR loop. Do NOT use for pure refactors where behavior doesn't change.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - tdd-worked-example.md
---

# noir-test-driven-development

Every feature starts with a failing test. The RED → GREEN → REFACTOR loop is the proof: if there's no failing test, there's no evidence the feature is needed. This skill absorbs `noir-test` — test design guidance lives here too.

## When to use

- You're about to implement a feature or fix a bug.
- The user says "write a test", "test this", or "TDD this".
- The implementation is non-trivial — a behavior change, new logic, or API contract.
- **Do NOT use:** for a pure rename, formatting change, or refactor where the existing test suite already covers the behavior.

## Procedure

### RED — Write the failing test
1. **Write the test FIRST.** Before any implementation code. The test must fail for the RIGHT reason (the feature is missing), not because of a syntax error or a broken import.
2. **The test is the spec.** Write it with the behavior you want to see — the input, the expected output, the edge cases. A good test reads like a user story: "given X, when Y, then Z."
3. **Run the test to confirm it fails.** The failure message must be clear — "feature not yet implemented", not "undefined is not a function."

### Verify RED — confirm it fails for the right reason
- The test fails on the assertion you wrote, not on setup/import/boot.
- If it fails for the wrong reason, fix the test (not the code under test) until it fails cleanly.

### GREEN — Implement the minimal code
- Write the smallest amount of production code that makes the test pass. Nothing more — no "future-proofing," no "while I'm here."
- Run the test. It must pass. Run the full suite to confirm no regression.

### Verify GREEN — confirm it passes legitimately
- The test passes on the assertion you wrote — not on a coincidental edge case.
- No other test broke. If one did, fix it NOW; do not carry a broken suite.

### REFACTOR — Clean up
- With a green suite as the safety net, clean up: remove duplication, improve naming, simplify logic. The test suite protects you — a broken refactor fails immediately.
- Run the full suite after every refactor step.

### Repeat
- For the next behavior, go back to RED. One test → one implementation → one refactor per cycle.

## Why order matters
Writing the test first forces you to state the desired behavior before you're influenced by the implementation. Writing the implementation to the test keeps you from building more than needed. Refactoring last, with a green suite, makes cleanup safe.

## Verification

- [ ] A failing test was written BEFORE the implementation.
- [ ] The test failed for the right reason (feature missing, not broken import).
- [ ] The minimal implementation made the test pass.
- [ ] The full test suite is green after the change.
- [ ] Refactored code is cleaner, not just different.

## Notes

- Don't test the framework. Test YOUR logic.
- One assertion per behavior, one test per behavior. A test that asserts five things is five tests fighting for attention.
- If TDD feels slow, you're probably fixing a bug that someone else shipped because they skipped it.

## Reference

For a worked RED → GREEN → REFACTOR walkthrough, see [tdd-worked-example.md](references/tdd-worked-example.md).

## When done → next skill

→ `noir-verifying` to gather evidence the work is complete. Or is there another behavior to implement?
