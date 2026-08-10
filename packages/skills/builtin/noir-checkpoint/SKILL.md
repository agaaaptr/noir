---
name: noir-checkpoint
description: Use when saving mid-session state before a context-risky moment or interruption — preserve the current task, progress, and open decisions. Use when the user says "save my place" or "checkpoint this". Do NOT use to close a session — use noir-wrap.
metadata:
  category: discovery
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-checkpoint

Save in-flight state so work survives an interruption, context-loss, or session restart. A checkpoint is a snapshot, not a close.

## When to use

- Mid-session, before a context-risky moment (long pause, context compaction, or interruption).
- The user says "save my place", "checkpoint this."
- **Do NOT use:** to close a session — use `noir-wrap`.

## Procedure

1. **Record open task state.** Which task is active, what phase it's in, what files are touched, what tests are in-flight. Use `noir task save` (or the SDD engine's checkpoint tooling).
2. **Note open decisions.** Anything the user and agent agreed on that hasn't been committed.
3. **Mark the workspace.** Dirty files, branch state, any uncommitted changes. The next session needs to know.
4. **Save memory.** Key insights from this session segment.
5. **Print the checkpoint summary.** Brief — next session reads this and resumes.

## Notes

- Checkpoints are temporary scaffolding, not permanent records. The engine's task state is the durable truth.
- You can checkpoint multiple times in a session — each one replaces the last.

## When done → next skill

→ The session can pause safely. When you return, `noir-sync` will find the checkpoint. Or continue working.
