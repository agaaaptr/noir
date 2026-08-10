---
name: noir-shipping
description: Use when shipping verified work — stage, commit with conventional-commit messages, decide integration (merge, PR, or keep local), and clean up. Use when the user says "commit this", "open a PR", or "ship it". Do NOT use when tests aren't green; verify first with noir-verifying.
metadata:
  category: git
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-shipping

Ship verified work. Absorbs `noir-commit`, `noir-pr`, and `noir-branch` into one surface: stage → commit → integrate → clean up.

## When to use

- Implementation is verified and it's time to ship.
- The user says "commit", "push", "PR", "merge", "ship this."
- **Do NOT use:** when tests aren't green. Do NOT use as "save my work" — use `noir-checkpoint`.

## Procedure

1. **Stage logically.** One logical change = one commit. No grab-bags.
2. **Write a conventional-commit message.** `type(scope): summary`. Body = why, not what.
3. **Run the pre-commit gate.** Lint, build, typecheck, test — must be green before committing.
4. **Decide integration.** On Claude Code, use `AskUserQuestion`: merge, PR, or keep local. On other hosts, ask plainly. Never push without asking.
5. **Clean up.** Scratch files, merged branches, temp notes.

## When done → next skill

→ `noir-wrap` to close the session. Or is there more to ship?

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
