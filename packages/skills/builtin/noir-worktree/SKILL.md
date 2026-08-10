---
name: noir-worktree
description: Use when creating an isolated git workspace for feature work — keeping the main checkout clean. Use when the user says "worktree" or "isolate this work".
metadata:
  category: git
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-worktree


## When to use
- When the user triggers this skill.

Isolate feature work from the current workspace via git worktrees. One feature, one directory, no cross-contamination.

## Procedure

1. **Confirm the feature needs isolation.** A single-file fix in a clean repo doesn't need a worktree. A multi-file feature with branches and dependencies does.
2. **Create the worktree.** `git worktree add -b <feature-branch> <path> <base-branch>`. On Claude Code, if a `.claude/worktrees/` pattern exists, follow it.
3. **Work in the isolated directory.** The worktree has its own checkout, and the original directory is untouched.
4. **When done, clean up.** `git worktree remove <path>` + `git branch -d <feature-branch>` (after merge).

## When done → next skill

→ `noir-shipping` to integrate the finished work. Or continue in the worktree.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
