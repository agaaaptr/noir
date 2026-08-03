---
name: session-starter
description: Use when starting a session on this repo, or when you need the global project context (direction, capability status, roadmap) loaded before planning or implementing. Fires automatically via SessionStart hook.
---

# Session Starter

Load the **global project context** for the Noir repo before any analysis, planning, or implementation. This skill establishes *where the project is headed and why*; the task-specific context is loaded separately by `task-starter`.

## When to use
- At the start of a session (fired by the SessionStart hook).
- Manually with `/session-starter` whenever you need the global direction re-anchored.
- **When NOT to use:** for a single localized task that already has clear scope — `task-starter` alone is enough.

## Context loading (progressive disclosure)

Read only what establishes direction; load detail on demand. Do **not** read every file in `docs/roadmap/`.

1. **Read the roadmap index + status:**
   - `docs/roadmap/README.md` — capability index, canonical philosophy, dependency graph, "how to use".
   - `docs/roadmap/STATUS.md` — per-capability status (shipped / partial / vision), active capability (C2 CLI Runtime), active slice (`cli-runtime`).
   - `docs/roadmap/releases.md` — current release (1.6.0), version targets, deferred features.
   - Optionally `docs/roadmap/backlog.md` — consolidated debt, if the session may touch deferred work.
2. **Recall cross-session memory** — run `/recall noir` (agentmemory) to load prior-session decisions, goals, and learnings for this project.
3. **Query the knowledge base** — `ctx_search` (context-mode) for project knowledge indexed from prior sessions (e.g. architecture decisions, past fixes, design rationale). Query with project-specific terms.
4. **Build a working summary** — distill into a compact context you carry through the session:
   - Project vision (AI-native, host-agnostic, spec-driven platform).
   - Which capabilities are shipped vs research.
   - Active capability / slice (C2 / cli-runtime).
   - Current release + any deferred work that may be relevant.
   - Constraints & engineering principles (single source of truth, spec-first, research-first, local-first).

## Validate before proceeding

- **Check for inconsistency** between the roadmap and what you observe (codebase, memory, context-mode). If you find a contradiction, note it and **ask the user** before implementing — do not assume.
- **Confirm context** with the user in one short summary before starting work: project understanding, the capability relevant to this session, dependencies to watch, and the approach you'll take.

## Notes

- **Future swap:** this skill currently uses the mature plugins (agentmemory `/recall`, context-mode `ctx_search`). When Noir itself is mature and initialized in this repo, replace these with Noir-native tools (`noir status`, `noir memory recall`, `noir context search`). Until then, do not require `noir init`.
- **Companion:** for task-level context, use [`task-starter`](../task-starter/SKILL.md).
