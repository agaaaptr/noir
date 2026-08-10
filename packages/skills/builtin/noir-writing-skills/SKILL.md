---
name: noir-writing-skills
description: Use when authoring or revising a Noir skill — ensure it is valid, WHEN+WHAT-described, structurally complete, and genuinely useful when invoked. Use when the user says "write a skill" or "update a skill". Do NOT use for general documentation.
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-writing-skills

The pack's authoring manual. Every skill must be: valid (passes `validateSkill`), structural (required sections), and genuinely useful (has concrete guidance the model doesn't already know). The meta-gate: `noir skills lint` reports pass/fail per skill.

## When to use

## Procedure
1. **Follow the guidance** in the notes and verification.

- Creating a new `noir-*` skill.
- Revising an existing skill's body, description, or metadata.
- The user says "write a skill", "update the skill", "add a skill for X."
- Verifying the pack — `noir skills lint`.

## Skill writing rules

1. **Frontmatter.** `name` = dir name (`noir-<kebab>`); `description` = WHAT+WHEN, ≤1024 chars, trigger-first, keyword-rich, with boundary ("Do NOT use for..."). Add `metadata.{category,version}`, `license`, `compatibility`. For args-taking skills, add `argument-hint`.
2. **Body.** Overview → When to use → Procedure (numbered) → Verification (`- [ ]` checklist) → Notes → "When done → next skill" footer.
3. **Quality gate.** `noir skills lint` checks: metadata presence, required sections, line budget (<500), one-level references, WHAT clause, thin-body warnings, no-example warnings. A skill that fails `validateSkill` cannot be emitted.
4. **Test it.** Every skill's directives must survive a real prompt. Write `evals/<skill>/evals.json` with offline assertions.
5. **No assumptions.** A skill that says "the user knows the project layout" is a broken skill. State the path, name the tool, give the command.

## Verification

- [ ] `validateSkill` passes (frontmatter + sections + budget).
- [ ] `noir skills lint` reports zero errors.
- [ ] The "When to use" and boundary are mutually-exclusive with sibling skills.
- [ ] The skill has a "When done → next skill" footer.

## When done → next skill

→ `noir skills lint` to verify the pack. Or continue authoring.
