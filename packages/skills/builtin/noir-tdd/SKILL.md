---
name: noir-tdd
description: Use when implementing any feature or bugfix — to write the failing test before the implementation.
---

Write the test first, watch it fail for the right reason, then write the minimal code that makes it pass. The cycle is red → green → refactor, in that order. The proof that a test actually tests something is that you saw it fail before the feature existed.

## Procedure

### RED — write one failing test
- One behavior per test. If the name contains "and", split it.
- A clear name that describes behavior (`retries failed operations 3 times`), not an index (`test1`).
- Real code paths, not mocks of the code under test — mock only external boundaries you do not own.
- Test the public behavior, not the implementation. A test that asserts on internal call shape breaks on every refactor.

### Verify RED — watch it fail
Run the test before writing any implementation. Confirm:
- it fails (does not error — a syntax or import error is not a red);
- the failure message is the one you expected;
- it fails because the feature is missing, not because of a typo in the test.

A test that passes immediately is testing existing behavior. Fix the test, not the cycle.

### GREEN — write the minimal code
Write the simplest code that turns the test green. No speculative options object, no "while I'm here" cleanup, no extra branches the test does not exercise. YAGNI is the rule in this step — the next test will ask for the next feature.

### Verify GREEN — watch it pass
Run the full suite, not just the new test:
- the new test passes;
- no other test regressed;
- the output is pristine — no warnings, no deprecation notices, no swallowed errors.

If another test broke, the implementation is not done. Fix it now, do not commit and move on.

### REFACTOR — clean up, stay green
Only after green: remove duplication, improve names, extract helpers. Run the suite after each refactor step. No new behavior lands during refactor — that requires a new RED.

### Repeat
Pick the next behavior, write its failing test, cycle again.

## Why order matters
Tests written after the implementation pass immediately, and a passing test proves nothing — it might test the wrong thing, it might assert on the implementation rather than the requirement, and you never saw it catch a bug. Test-first forces edge-case discovery before the implementation makes the edge case look easy.

A bug found in the wild is treated the same way: write the failing test that reproduces it, watch it fail, fix at the root, watch it pass. The test stays in the suite as the regression guard.

## Notes
- Discipline is observable, not rhetorical: the SDD engine records the execute-phase gate, and a regression test counts only after a red→green cycle was observed — a test that passed once is not evidence of a fix.
- If the test is hard to write, the design is hard to use. Listen to the test before fighting it; the friction usually names a real coupling problem.
- When you genuinely must explore an API before designing it, throw the exploration away and start the implementation from a fresh failing test. "Keep it as reference" is how tests-after slips in.
