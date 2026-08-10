---
name: noir-wrap
description: Use when closing a work session cleanly — running final verification, updating docs and CHANGELOG, saving memory, and emitting a host handoff. Do NOT use mid-session for a checkpoint — use noir-checkpoint.
metadata:
  category: meta
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-wrap

Close a session in a clean, recoverable state. This skill absorbs `noir-document` (update docs/CHANGELOG/memory) — wrap is the superset that covers the full close.

## When to use

- Ending a work session.
- The user says "wrap up", "I'm done", "close this out."
- **Do NOT use:** mid-session — use `noir-checkpoint`.

## Procedure

1. **Run final verification.** Same gate as `noir-verifying`: test suite, lint, typecheck. Evidence, not assumption.
2. **Update docs.** CHANGELOG, ADRs, decisions, reference docs — anything that should reflect the session's work. The rule: docs reflect shipped reality, never a stale plan.
3. **Save memory.** Persist observations, decisions, patterns the next session should recall. `noir memory save` (or `noir.remember` MCP tool).
4. **Confirm commits.** Commits are made and intentional (local or pushed). Noir defaults to local.
5. **Advance the workflow task.** `noir task advance --to <phase>` if a gate is satisfied.
6. **Emit the handoff.** `noir handoff` (text-only prompt; `--write` persists to `.noir/handoff/`; `--json` for CI). Names the active task, next gate's skill, and the host-launch directive.

## Verification

- [ ] Gate is green (tests, lint, typecheck).
- [ ] Docs are synced (CHANGELOG, decisions, references).
- [ ] Memory is saved (key observations + decisions).
- [ ] Handoff emitted (the next session can resume).

## When done → next skill

The session is closed. Until next time.
