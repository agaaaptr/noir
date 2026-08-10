---
name: noir-recall
description: Use when searching Noir's cross-session memory for past decisions, patterns, bugs, or facts — before re-deriving something already known. Use when starting a task; when the user says "recall", "what did we do", or "what did we decide about X". Do NOT use to save new information — use noir-remember.
metadata:
  category: memory
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-recall

Query cross-session memory for what was already decided, discovered, or documented — before you re-derive it.

## When to use

- Starting a task that may have prior context.
- The user says "recall", "what did we do about X", "do we have any memory of Y."
- There's a decision to make and prior sessions may have already made it.
- **Do NOT use:** to save — use `noir-remember`. To search code — use `noir-exploring`.

## Procedure

1. **Form a specific query.** What decision, pattern, or fact are you looking for? A vague "anything relevant" produces noise.
2. **Search memory.** On Noir projects, use `noir memory recall <query>` (or the `memory_recall` MCP tool). If no memory tool is available, check `.noir/` artifacts (specs, plans, tasks) as the durable fallback.
3. **Surface 2-4 top matches.** State what was found and when it was recorded. If nothing found, say so — don't fabricate.
4. **Apply to the current task.** If a prior decision is relevant, cite it; if it's stale, note that and ask the user.

## Verification

- [ ] Memory was queried before making assumptions.
- [ ] Results are cited with source (date/session).
- [ ] No fabricated memories.

## When done → next skill

→ Route to the relevant noir skill based on what you recalled. Or is there something else?
