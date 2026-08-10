---
name: noir-rules
description: Use when reviewing or editing the project's AI working-rules (.noir/rules/RULES.md) — decide whether a directive belongs in the always-on contract vs a skill, a memory, or an ADR. Use when the user says "update the rules" or "add a rule".
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-rules

The project's AI working-rules at `.noir/rules/RULES.md` — the always-on contract. Every line costs context in every session, so a rule must earn its place.

## When to use

## Procedure
1. **Follow the guidance** in the notes and verification.

- The user says "add a rule", "update rules", "should this be a rule?"
- A convention is being repeated verbally every session — it's time to codify it.
- A rule is growing stale — it's time to prune or archive.

## Keeping rules lean

1. **One rule, one line.** If it needs a paragraph, it belongs in a skill, a memory, or an ADR.
2. **Use the most specific mechanism.** A directive you want ALWAYS active → rule. A directive you want on-demand → skill. A decision worth recalling → memory. An architecture decision with rationale → ADR.
3. **Prune stale rules.** `noir doctor rules` checks the budget.

## When done → next skill

→ The relevant noir skill for the change the rule governs. Or continue.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
