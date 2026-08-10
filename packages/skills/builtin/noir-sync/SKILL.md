---
name: noir-sync
description: Use when starting any session or conversation — load project context and route to the relevant noir skill. Fires on explicit signals (feature start, spec request, new task). Do NOT use mid-session for a status update; use noir-checkpoint.
metadata:
  category: discovery
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-sync — Session starter and skill router

Load the project context AND route to the right skill. This is the entry point for every session — read anchors, check state, recall memory, then hand off to the noir skill that matches the task. Stay silent on trivial edits; fire on explicit signals.

## When to use

- Start of a session — before any other action.
- The user opens a new conversation or says "let's work on X."
- **Do NOT use:** mid-session for progress — use `noir-checkpoint`. Do NOT use for a one-line fix with no design.

## Procedure

1. **Read anchors.** `CLAUDE.md`, `AGENTS.md`, `.noir/NOIR.md` — always-on context to ground the session. On Claude Code, use `Read`; on other hosts, use the equivalent file tool.
2. **Check git state.** `git rev-parse --abbrev-ref HEAD`, `git status --porcelain`, `git log --oneline -5`. Note any dirty tree or in-progress work.
3. **Check Noir state.** Read `.noir/tasks/` for an in-flight task. If one exists, surface its phase and offer to resume.
4. **Recall memory.** Query Noir memory (or the host's recall tooling) for 2-4 top facts relevant to this session. If empty, say so — `.noir/` is the durable fallback.
5. **Skill triage.** Map the user's intent to the right noir skill. These are the high-value skills:
   - Feature/idea → `noir-brainstorming` → `noir-spec` → `noir-planning` → `noir-executing-plans`
   - Bug/crash → `noir-systematic-debugging`
   - Implement with TDD → `noir-test-driven-development`
   - Verify/PR → `noir-verifying`
   - Ship/integrate → `noir-shipping`
   - Close session → `noir-wrap`
   - Code exploration → `noir-exploring`
   - Skill authoring → `noir-writing-skills`
6. **Print a brief** — project type, stack, key commands, in-flight task. Then hand off to the routed skill.

## Notes

- Don't auto-start work. Surface the state and let the user confirm direction.
- If no skill matches, ask what the user wants to do — the route is a suggestion, not a mandate.

## When done → next action

Route to the matched skill. Or is there something else you'd like to do first?
