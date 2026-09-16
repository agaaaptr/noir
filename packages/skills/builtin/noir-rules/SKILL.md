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

- The user says "add a rule", "update rules", "should this be a rule?"
- A convention is being repeated verbally every session — it's time to codify it.
- A rule is growing stale — it's time to prune or archive.

## Procedure

1. **Question the rule first.** A rule must be active in *every* session to earn its place. If it is only sometimes relevant, it belongs in a skill (on-demand) or a memory (recall-by-need) instead.
2. **Read the current rules.** `.noir/rules/RULES.md` is the source of truth. Extend or sharpen an existing line rather than adding a near-duplicate.
3. **Write one imperative line.** State the directive, not the rationale. If it needs a paragraph, the reasoning belongs in a skill or an ADR.
4. **Edit the source file.** Change `.noir/rules/RULES.md`; the host files (CLAUDE.md, AGENTS.md, and the rest) carry a managed import block that points at it, so they pick the change up on the next `noir sync`. Never hand-edit the generated block.
5. **Check the budget.** Run `noir doctor` and read the `rules budget` row.

## Keeping rules lean

1. **One rule, one line.** If it needs a paragraph, it belongs in a skill, a memory, or an ADR.
2. **Use the most specific mechanism.** A directive you want ALWAYS active → rule. A directive you want on-demand → skill. A decision worth recalling → memory. An architecture decision with rationale → ADR.
3. **Prune stale rules.** Plain `noir doctor` reports the RULES.md size under its `rules budget` row (over-budget is a `warn`, never a `fail`).

## When done → next skill

→ The relevant noir skill for the change the rule governs. Or continue.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
