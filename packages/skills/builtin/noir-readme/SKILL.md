---
name: noir-readme
description: Use when generating or updating a project README or documentation from the codebase — keeping docs accurate. Use when the user says "write a README" or "update the docs"; when a new feature ships.
metadata:
  category: document
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-readme

Generate or update project documentation — README, docs index, package docs. The rule: docs reflect shipped reality, never a stale plan.

## When to use

- A new project needs a README.
- A feature shipped and the docs must reflect it.
- The user says "write docs", "update README", "document this."

## Procedure

1. **Survey the codebase.** What does the project do? What's the entry point? What commands matter? Read the README and any existing docs.
2. **Follow the project's doc convention.** If the project uses Diátaxis (tutorial/how-to/reference/explanation), follow it. If not, standard README sections: intro, install, usage, contributing, license.
3. **Keep docs lean.** A 50-line README that's accurate beats a 200-line README that's outdated. Link to deeper docs — don't inline them.
4. **Run `pnpm docs:validate`** if the project has doc validation — catch broken links and stale refs before committing.

## When done → next skill

→ `noir-shipping` to commit the doc update. Or continue.

## Notes
- This skill is a playbook — the host decides which tools to use.
