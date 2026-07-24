---
name: noir-debug
description: Use when encountering any bug, test failure, or unexpected behavior — before proposing a fix.
---

Find root cause before attempting any fix. Symptom patches waste time and create new bugs; the path is investigate → hypothesize → test → fix, in that order. Skipping ahead is the most expensive move in debugging.

## Procedure

### 1. Reproduce and read
- **Read the error completely.** Stack traces, line numbers, file paths, error codes — do not skim past the message; it usually narrows the search immediately.
- **Reproduce reliably.** Find the minimal, repeatable trigger. If you cannot reproduce it, gather more data; do not guess at a fix from a single trace.
- **Check recent changes.** `git diff` and recent commits often point straight at the cause. Note new dependencies, config edits, and environmental differences.

### 2. Gather evidence at component boundaries
When the system has multiple layers (CLI → adapter → daemon → store, or API → service → database), instrument each boundary before proposing fixes: log what enters and what exits, verify config propagation, check state at each layer. Run once, read the output, then investigate the specific layer the evidence implicates.

### 3. Trace data flow to the source
For a bad value deep in a call stack, trace backward: where does it originate, who passed it down, who created it. Fix at the source, not at the symptom. Resist the urge to patch where the symptom surfaces.

### 4. Find the pattern
Locate similar working code in the same codebase and list every difference from the broken path — however small. When applying a known pattern, read the reference implementation completely; partial understanding is a common cause of the bug you are now debugging.

### 5. Form one hypothesis and test minimally
State the hypothesis explicitly ("I think X is the root cause because Y"). Make the smallest possible change that would prove or disprove it — one variable at a time, never a bundle. If the hypothesis survives the minimal test, proceed; if not, form a new hypothesis with the new information. Do not stack fixes on top of a failed one.

### 6. Fix at the root, with a regression test
- Write the simplest failing test that reproduces the bug (see `noir-tdd`).
- Implement the single fix at the root cause.
- Verify the test goes green and that no other test regressed.
- One change at a time; no "while I'm here" refactors bundled into the fix.

### 7. Know when to stop fixing
If three or more fixes have failed, each revealing a new problem in a different place, the issue is likely architectural, not a missing patch. Stop, name the pattern that is not holding, and surface the architectural question (with evidence) instead of attempting fix number four.

## Notes
- Discipline is observable, not rhetorical: the SDD engine records the debug gate via `noir.checkpoint` with the failing test and the eventual fix attached.
- Most "no root cause found" cases are incomplete investigations. If the issue is genuinely environmental or timing-dependent after a complete pass, document what you investigated, implement appropriate handling (retry, timeout, error message), and add monitoring — but say so plainly rather than implying the root cause is unknowable.
