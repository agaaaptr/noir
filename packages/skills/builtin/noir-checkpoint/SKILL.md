---
name: noir-checkpoint
description: Use mid-session — to save in-flight state before a context-risky moment or interruption, so work survives.
---

Save in-flight state so work survives a context-risky moment (compaction, handoff, or interruption). Persists the task's phase, progress, and next step into `.noir/` and records the checkpoint observably via `noir.checkpoint`.

## Procedure
1. **Find the task.** Locate the active task stub under `.noir/tasks/<id>.md` (the S4 engine's persisted state). If none, ask the user which task to checkpoint — or note "no active task — nothing to checkpoint" and stop.
2. **Capture state.** Update `.noir/tasks/<id>.md`: set the current phase, a status line (e.g. `checkpointed @ phase N`), an `updated:` timestamp, and fill *done so far* + *next steps* + any blockers. Append a one-line history entry so a fresh session can pick up cleanly.
3. **Record the checkpoint.** Call `noir.checkpoint` so the SDD engine records the save observably; the task stub is the source of truth, the checkpoint is the durable signal that survives context loss.
4. **Memory (best-effort).** Save the checkpoint to Noir memory (phase + key decisions + next step) if the host's memory tooling is available. Skip cleanly if not — `.noir/tasks/<id>.md` remains the durable record either way.
5. **Uncommitted work.** Note any uncommitted changes (`git status --porcelain`) in the checkpoint and advise the user — commit or stash before truly leaving, or the on-disk state and the working tree will diverge.
6. **Report.** State the task id, the phase, and the next step. Point to the SDD lifecycle to resume — do not invent a slash command.

## Fallbacks
- No active task → say so; nothing to checkpoint.
- `noir.checkpoint` or Noir memory unavailable → skip silently; the task stub is the source of truth and the engine degrades read-only rather than failing.
