---
name: noir-e2e
description: Use when writing, running, or debugging end-to-end / UI tests, when asked to QA or bug-bash an app, or when the verify gate needs user-visible evidence — author tests that pair a natural-language goal the host agent drives with deterministic locator assertions, then register the run as a verify-gate check.
metadata:
  category: verify
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - authoring.md
  - running.md
  - debugging.md
  - explore.md
  - bug-bash.md
  - verify-gate.md
---

# noir-e2e

End-to-end tests prove what a unit test cannot: the real app does what the
user asked. This skill adopts the hybrid testing doctrine in a host-agnostic
way. The natural-language step is executed by YOU, the host agent, through
your own tools (browser automation, Playwright MCP, the running app). The test
file then pins every outcome with an exact assertion, so a later run is
deterministic and needs no model.

## When to use

- The verify gate needs evidence that a user-visible behavior works, not just
  that functions pass.
- You are writing a UI / browser / mobile test, or the user says "e2e",
  "end-to-end", "UI test", "browser test", "QA", or "bug bash".
- A change touches a flow, form, route, or screen a unit test cannot reach.
- **Do NOT use** for pure logic that a unit test already proves.

## Procedure

1. Pick the runner the project already uses (Playwright, Cypress, vitest
   browser mode). Never add a dependency when one is present. See
   [authoring.md](references/authoring.md).
2. Learn the screen before writing: read the component for its accessible
   names, or open the app and look. A locator names what the user sees, not a
   class name.
3. Write the test as a hybrid: drive the flow with one natural-language goal
   per step (you execute it while authoring), then pin each outcome with an
   exact assertion. Judge meaning, not phrasing.
4. Run it and read the failure as evidence. See [running.md](references/running.md)
   and [debugging.md](references/debugging.md). Never add a sleep.
5. Register the run as a verify-gate check so it gates "done". See
   [verify-gate.md](references/verify-gate.md).
6. For a broad QA pass, drive [explore.md](references/explore.md) and
   [bug-bash.md](references/bug-bash.md); every bug found gets a repro test.

## Rules

- Secrets never appear in test code. Resolve credentials from the project's
  own secret source; never commit a real password or token.
- One natural-language goal per step. Exact values go through the locator, not
  the prose.
- The runner's output directory is read-only. Read the trace, never edit it.
- A recorded step replays without re-deriving the whole flow; a re-run on an
  unchanged app should not re-ask the model.

## Verification

- [ ] The test proves a user-visible behavior on the running app.
- [ ] Each natural-language step is pinned by an exact assertion.
- [ ] The e2e run is registered as a verify-gate check, not run once by hand.
- [ ] The failure path is exercised, not only the happy path.

## When done → next skill

→ `noir-verifying` to collect the e2e evidence alongside build / lint /
typecheck into the gate record.
