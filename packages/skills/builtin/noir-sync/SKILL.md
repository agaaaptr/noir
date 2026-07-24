---
name: noir-sync
description: Use at the start of a session — to load project context (anchors, git state, setup) and recall prior memory before doing anything else.
---

Load project context at session start. Read-only — do not edit project files. Discipline comes from the SDD engine's observable gates, not from this skill.

## Procedure
1. **Read anchors.** Read `CLAUDE.md` / `AGENTS.md` (always-on context) to ground the session.
2. **Project setup.** Detect stack + the test/run command from manifests and `CLAUDE.md`; note project type. Informational — flag anything non-conventional, do not mutate.
3. **Git state.** `git rev-parse --abbrev-ref HEAD`; `git status --porcelain`; `git log --oneline -5`.
4. **Noir state.** Read `.noir/NOIR.md`; check `.noir/tasks/` for an in-flight task (the S4 engine's persisted state). If one exists, surface its phase via `noir.workflow_status` and offer to resume it through the SDD lifecycle — do not auto-resume.
5. **Recall memory.** Query Noir memory (or the host's recall tooling, if any); surface 2–4 top facts relevant to the current task. If empty, say so — `.noir/` artifacts are the durable fallback.
6. **Print a brief** of essentials only (project type, stack, key commands, in-flight task) — no large dumps. Then await the user; do not auto-start work.

## Fallbacks
- No memory found → say so; `.noir/NOIR.md` + `.noir/tasks/` are always the durable record.
- Not initialized (no `.noir/`) → tell the user to run `noir init` before continuing.
