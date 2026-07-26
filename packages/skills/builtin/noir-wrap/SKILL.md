---
name: noir-wrap
description: Use when closing a session cleanly — run tests, curate docs, confirm commits, save memory, emit a host handoff.
---

# noir-wrap

Use when you are ending a session and want to leave the work in a clean, recoverable state — and hand off to the host CLI with a ready-to-paste prompt.

## Steps

1. Run the project's test command (the host detects it; if unknown, `pnpm test` / `npm test`).
2. Curate or delete ephemeral notes (scratch docs, dead branches, tmp files).
3. Confirm commits are made — and pushed or intentionally local (Noir keeps commits local + conservative by default).
4. Save durable memory before closing: observations, decisions, patterns the next session should recall. Prefer `noir memory save` (or the `noir.remember` MCP tool from the host) so cross-session recall works.
5. Advance the workflow task if a gate is satisfied: `noir task advance --to <phase>` (the verify gate prints the handoff hint automatically).
6. Emit the host handoff — run `noir handoff` (or the session-end alias `noir wrap`). This prints a ready-to-paste markdown prompt to STDOUT that names the active task, the next gate's skill, a bounded context/memory seed, and the exact host-launch directive. Pipe it straight into the host, or persist with `noir handoff --write` (the path is gitignored under `.noir/handoff/`).

## Notes

- `noir handoff` reuses the same snapshot as `noir status` and the same phase→skill map as `noir task next`, so the handoff is always consistent with the live state.
- The handoff directive is TEXT ONLY — Noir never launches the host. Paste the block into the host CLI to resume.
- For a machine-readable handoff (e.g. a CI consumer), use `noir handoff --json`.
