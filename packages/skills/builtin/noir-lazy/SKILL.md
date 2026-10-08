---
name: noir-lazy
description: Use when the user says "be lazy", "simplest solution", "do less", "yagni", "shortest path", or "minimal solution". Climb the laziness ladder before writing code, and record each deliberate shortcut with a ceiling and a trigger. Do NOT use for non-coding requests, or as a whole-repo audit; noir-codebase-audit owns that pass.
metadata:
  category: execute
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-lazy

Adopt the laziness ladder as the stance for the next coding change: make the smallest change that is still correct, and record every deliberate shortcut with a ceiling and a trigger so a later reader can pay it back.

## When to use

- The user says "be lazy", "simplest solution", "do less", "yagni", "shortest path", or "minimal solution".
- A request is growing and a smaller version would cover it.
- **Do NOT use** for non-coding requests, or as a whole-repo audit. This skill is a stance applied while coding; the repo-wide pass that deletes dead code is `noir-codebase-audit`.

## Procedure

1. **Climb the ladder before writing.** Ask the questions in order and stop at the first rung that holds: does this need to exist at all; is it already in this repo; does the stdlib cover it; does the platform; does an installed dependency; can it be one line. Write the minimal code only when every earlier rung failed.
2. **Fix the root cause, not the symptom.** Grep every caller of the function about to change before editing. One guard in the shared function is a smaller diff than a guard in each caller, and it fixes the sibling callers the ticket never named.
3. **Delete over add.** When two changes produce the same behavior, take the one that removes a line.
4. **Record deliberate shortcuts.** A cut corner with a known ceiling gets a marker, not silence. For example: `// noir-debt: global lock, per-account locks when throughput matters`. Name both the ceiling and the upgrade trigger; the trigger half is not optional.

## Verification

- [ ] Each rung was considered in order, and the answer is the highest rung that held.
- [ ] The fix sits at the shared root, not duplicated across callers.
- [ ] Every deliberate shortcut carries a `noir-debt:` marker with a ceiling and a trigger.
- [ ] The diff is the shortest change that solves the stated problem, and nothing else.

## Notes

- Lazy means efficient, not careless: read the task and the code it touches before climbing the ladder.
- Two stdlib options of the same size: take the one that is correct on edge cases, not the flimsier one.
- State what was skipped and when to add it, in one line, instead of building it now.

## When done → next skill

→ `noir-verifying` to prove the change works. Or `noir-debt` to harvest the markers just written into a ledger.
