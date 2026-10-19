# Debugging a failed e2e run

A failure is evidence. Read it before changing anything.

## Read the trace first

Open the trace, screenshot, and video the runner wrote for the failing test.
Confirm what actually happened on screen before you decide whether the locator,
the expectation, or the app is wrong. Never fix a test you have not watched
fail.

## Common failures

- Ambiguous locator: two nodes match. Narrow it with a role + accessible name,
  not an index.
- Timeout waiting for a node: the app did not reach the expected state. The
  assertion or the step is wrong, or the app has a real bug.
- Wrong text: the app renders differently than the assertion. Update the
  assertion only if the app is correct; otherwise it is a product bug.

## Never

- Never add a `sleep` or a fixed wait. Wait for a condition or a matcher.
- Never delete a failing test to make the suite green. Fix the cause or record
  the product bug with a repro.

## Reproduce before fixing

Trigger the failure path deliberately, then re-run to confirm the fix makes
the test pass and no sibling test breaks.
