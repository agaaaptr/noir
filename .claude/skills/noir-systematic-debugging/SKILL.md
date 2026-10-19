---
name: noir-systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior — find the root cause methodically before proposing any fix. Use when the user says "this is broken", "it fails intermittently", or pastes a stack trace. Do NOT use for a known fix where the root cause is already confirmed.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - tracing.md
---

# noir-systematic-debugging

Find root cause before attempting any fix. Symptom patches waste time and create new bugs; the path is investigate → hypothesize → test → fix, in that order. Skipping ahead is the most expensive move in debugging.

## When to use

- A bug, test failure, or unexpected behavior appears — and you don't know the root cause yet.
- The user says "this is broken", "it fails", "something's wrong", or pastes a stack trace.
- A test passed yesterday and fails today, or it fails intermittently.
- **Do NOT use:** when the root cause is already clear and the fix is obvious (one-line patch with no risk of side effects).

## Procedure

### 1. Reproduce and read
- Read the error completely. Stack traces, line numbers, file paths, error codes — do not skim past the message; it usually narrows the search immediately.
- Reproduce reliably. Find the minimal, repeatable trigger. If you cannot reproduce it, gather more data; do not guess at a fix from a single trace.
- Check recent changes. `git diff` and recent commits often point straight at the cause. Note new dependencies, config edits, and environmental differences.

### 2. Gather evidence at component boundaries
When the system has multiple layers (CLI → adapter → daemon → store, or API → service → database), instrument each boundary before proposing fixes: log what enters and exits, verify config propagation, check state at each layer. On Claude Code, use `Bash` to run the exact failing command with verbose flags; on other hosts, use whatever shell/execution tool is available. Run once, read the output, then investigate the specific layer the evidence implicates.

### 3. Trace data flow to the source
For a bad value deep in a call stack, trace backward: where does it originate, who passed it down, who created it. Fix at the source, not at the symptom. Resist the urge to patch where the symptom surfaces.

### 4. Find the pattern
Locate similar working code in the same codebase and list every difference from the broken path — however small. When applying a known pattern, read the reference implementation completely; partial understanding is a common cause of the bug you are now debugging.

### 5. Form one hypothesis and test minimally
State the hypothesis explicitly ("I think X is the root cause because Y"). Make the smallest possible change that would prove or disprove it — one variable at a time, never a bundle. If the hypothesis survives the minimal test, proceed; if not, form a new hypothesis with the new information. Do not stack fixes on top of a failed one.

### 6. Fix at the root, with a regression test
- Write the simplest failing test that reproduces the bug (see `noir-test-driven-development`).
- Implement the single fix at the root cause.
- Verify the test goes green and that no other test regressed.
- One change at a time; no "while I'm here" refactors bundled into the fix.

### 7. Know when to stop fixing
If three or more fixes have failed, each revealing a new problem in a different place, the issue is likely architectural, not a missing patch. Stop, name the pattern that is not holding, and surface the architectural question (with evidence) instead of attempting fix number four.

## Verification

- [ ] The bug is reproduced reliably (the trigger is documented).
- [ ] A root cause hypothesis is stated explicitly ("X because Y").
- [ ] The fix is at the source, not the symptom.
- [ ] A regression test passes and no other tests regressed.
- [ ] One commit per fix — no bundled refactors.

## Notes

- "No root cause found" is usually an incomplete investigation. If the bug is genuinely environmental or timing-dependent after a complete pass, document what you investigated, implement appropriate handling (retry, timeout, error message), and add monitoring — but say so plainly rather than implying the root cause is unknowable.
- If the bug spans multiple services, use `noir-exploring` to fan out the evidence search first.

## Reference

For deeper detail, see [tracing.md](references/tracing.md).

## When done → next skill

→ `noir-verifying` to confirm the fix is complete. Or do you need to investigate another bug?
