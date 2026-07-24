---
name: noir-commit
description: Use when creating a git commit — to scope changes logically and write a conventional-commit message.
---

# noir-commit

> **Stub:** this skill ships as a valid, loadable placeholder in S5; its full playbook is deepened in a later slice.

**When to use:** you are about to commit and want changes scoped to one logical concern with a conventional-commit message (`type(scope): subject`).

**For now:** stage one logical change at a time (`git add <paths>`), write a concise conventional-commit message, and verify with `git status` before committing. Never bundle unrelated changes.
