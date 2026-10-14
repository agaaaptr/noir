# Running e2e tests

Run the same command CI runs, and keep the evidence it produces.

## Run

Run the runner the project already configures, e.g. `pnpm test:e2e`,
`npx playwright test`, or `npx cypress run`. Run the whole suite, not only the
file you touched, unless you are mid-iteration.

## Evidence

- The run must print or write a machine-readable result (a report, a JUnit
  file, a summary). Keep that artifact for the verify gate.
- A failing test names its trace, screenshot, and video. Point to them, do not
  paraphrase.
- The output directory (`.e2e/`, `playwright-report/`, `cypress/`) is
  read-only. Read the trace, never edit it.

## CI

The suite is a gate, not a local convenience. It runs on every change to the
relevant flow. Flaky is a bug to fix, not a fact to route around: a test that
sometimes passes is a test that proves nothing.

## Exit code

A non-zero exit is the signal the gate consumes. Do not wrap the run in a
script that swallows the exit code; the gate reads it.
