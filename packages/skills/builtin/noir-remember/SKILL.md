---
name: noir-remember
description: Use when persisting an insight, decision, pattern, or bug to Noir's cross-session memory. Use when the user says "remember this" or "save this"; when an insight surfaces during a session. Do NOT use for routine progress.
metadata:
  category: memory
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-remember

Save durable insights so the next session doesn't start from zero.

## When to use

- An important decision, pattern, or bug workaround surfaces.
- The user says "remember this", "save this", "don't forget this."
- A pattern repeats across sessions — it's worth formalizing.
- **Do NOT use:** for routine progress updates (those live in the task state).

## Procedure

1. **Identify what's worth keeping.** A decision with a reason, a pattern that recurred, a bug with its root cause, a preference the user stated.
2. **Write a short, searchable entry.** Key concepts + why it matters. Keep it focused — one fact per entry.
3. **Persist it.** On Noir projects, use `noir memory save <content>` (or the `memory_save` MCP tool).
4. **Confirm.** Say what was saved so the user knows it'll survive.

## In a shared workspace

If this repo has joined a **shared workspace** (two repos, one product — e.g. a
backend and a frontend, via `noir daemon join <name>`), **every** save goes to
the **shared** store. There is no per-repo memory while a repo is joined: a
sibling repo's sessions can read what you write here, immediately.

Two consequences for what you save:

- **Write for the outsider.** The sibling repo's agent never saw your files. Prefer
  a decision plus its reason over a repo-local detail it cannot act on.
- **Provenance is automatic.** The daemon stamps which repo wrote the entry from
  the request identity — never state it yourself, and never guess a sibling's.

## Verification

- [ ] The entry is one focused fact (not a grab-bag).
- [ ] Key concepts are named (searchable later).
- [ ] The entry has a "why" — not just "what."

## When done → next skill

→ `noir-wrap` if closing, or continue working.
