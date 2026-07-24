---
name: noir-verify
description: Use when about to claim work is complete or fixed — to run verification and gather evidence before asserting success.
---

Run the commands that prove the claim, read their output, and report the actual status with evidence. No completion or fix claim is made until fresh output backs it.

## Procedure
1. **Name the claim and its proof.** For each thing you are about to assert ("tests pass", "lint clean", "build succeeds", "bug fixed", "requirements met"), name the exact command that would prove it. A claim with no proof command is not yet a claim.
2. **Run each command fresh.** Full invocation in this turn — not a previous run, not a cached result, not a partial check. Capture stdout, exit code, and failure counts.
3. **Read the output before asserting.** If the output confirms the claim, state the claim with the evidence. If it contradicts the claim, state the actual status with evidence and stop — do not soften, do not promise a follow-up.
4. **Refuse common substitutes for evidence.** "Should work now", "I'm confident", "the linter passed so the build is fine", "the agent reported success", and "partial check is enough" are not evidence. Partial output proves nothing about the whole.
5. **Record and route.** Capture the verification result via `noir.checkpoint` (the SDD engine's verify gate). Only then point to `noir-document`.

## Notes
- The rule is procedural, not rhetorical: name the proof, run it, read it, then claim. The engine records that the verify gate ran with output attached.
- A regression test counts only after a red→green cycle is observed. A test that passes once is not evidence of a fix.
