---
name: noir-security
description: Use when reviewing code for security vulnerabilities — injection, auth, SSRF, data exposure, and supply chain risks. Use when the user says "security review" or "audit this for security"; before shipping a feature that handles user input, auth, or sensitive data.
metadata:
  category: verify
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - security-checklist.md
---

# noir-security

Review changes for vulnerabilities — not a pen-test, but the baseline every feature should pass before shipping.

## When to use

- A feature handles user input, authentication, or sensitive data.
- The user says "security review", "check this for vulnerabilities", or "is this safe."
- Before `noir-shipping` for a security-sensitive change.

## Procedure

1. **Check surface area.** What data enters? What exits? Who can call it? What's authenticated?
2. **Check injection.** SQL, shell, template injection paths — review every dynamic string used in a command or query.
3. **Check auth.** Is every endpoint gated? Is the auth check before any data access? No "if admin → show data" then "else → also show data because we forgot a return."
4. **Check secrets.** Any hard-coded keys, tokens, or passwords? (Check committed files, not env vars).
5. **Check dependencies.** Any new packages? Known vulnerabilities? Pinned versions that are stale?
6. **Report findings.** Severity (critical/high/medium/low) + location + fix. One finding per entry.

## When done → next skill

→ `noir-shipping` if clean, or `noir-systematic-debugging` if a vulnerability needs fixing.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
