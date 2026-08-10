---
name: noir-doctor
description: Use when diagnosing environment or project health — dependencies, config, runtime, toolchain, and Noir store integrity. Do NOT use for routine status checks — use noir-sync or noir-checkpoint.
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-doctor


## When to use
- When the user triggers this skill.

Check what's wrong. Run `noir doctor` and read every row — the command groups findings by category (install, config, store, daemon) and reports pass/warn/fail per check. Advisory, not mandatory — even a red check doesn't block.

## Procedure

1. **Run `noir doctor`.** In-process — no daemon needed. Read the full output on stderr.
2. **Surface actionable issues.** A failed check should tell you what to fix. The install row checks Node version + managed runtime (if installed via native installer).
3. **Fix one at a time.** Don't batch fixes — each fix deserves its own verification that the underlying issue resolved.
4. **Re-run `noir doctor` to confirm green.**

## When done → next skill

→ The relevant skill for whatever was broken. Or continue working with a green doctor.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
