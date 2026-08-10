---
name: noir-verifying
description: Use when about to claim work is complete — gather evidence (tests, gate, criteria) before asserting success. Use when the user says "is this done?" or "verify this". Do NOT use mid-implementation for a progress check; use noir-checkpoint.
metadata:
  category: verify
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - verification-checklist.md
---

# noir-verifying

Gather evidence before asserting success. Absorbs `noir-verify` and `noir-review` into one gate: run, read, verify, then claim done.

## When to use

- About to claim a task, feature, or fix is complete.
- The user says "verify this", "is this done?", "check everything."
- **Do NOT use:** mid-implementation — use `noir-checkpoint`.

## Procedure

1. **IDENTIFY criteria.** Load spec/plan — each acceptance criterion is a verification item.
2. **RUN the gate.** Execute the project's test command. The output IS the evidence.
3. **READ results.** A passing suite is the minimum; verify each criterion explicitly.
4. **Check side effects.** New lint warnings? Type errors? Doc links? Run the full gate.
5. **ONLY THEN claim done.** State "verified: <evidence>" — never "verified: looks good."

## Reference

For the full claim-done + PR-review checklist, see [verification-checklist.md](references/verification-checklist.md).

## When done → next skill

→ `noir-shipping` to commit and integrate, or `noir-wrap` to close. Or something else?

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
