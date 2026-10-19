---
name: noir-exploring
description: Use when answering means sweeping many files, directories, or naming conventions — fan out read-only search and return the conclusion, not the dumps. Use when the user says "find all places where X", "what uses Y", or "audit the codebase for Z". Do NOT use for a targeted single-file read.
metadata:
  category: discovery
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-exploring

Fan-out search for broad questions. One exploration = pattern → found → conclusion. The host reads excerpts, not whole files. You report the conclusion, not the dumps.

## When to use

- A question spans dozens of files.
- The user says "where is X used", "find all Y", "audit the codebase for Z."
- A naming convention, import pattern, or API usage needs a broad sweep.
- **Do NOT use:** for a single file lookup — just use Read/Grep directly.

## Procedure

1. **Define the search.** What pattern are you looking for? Name it explicitly so the search is targeted.
2. **Fan out.** On Claude Code, use `Grep` and `Glob` to find matches across the codebase. On other hosts, use the equivalent search tools. Search by file name, by content, or by dependency — pick the right tool per pass.
3. **Synthesize, don't dump.** Read the relevant excerpts, form a conclusion, and report it. The host should never see raw 700-line grep output; they see "3 locations found, pattern is X."
4. **Hand off.** If the exploration found something worth acting on, point to the right skill.

## Verification

- [ ] Search was broad enough to cover the question (not just one dir).
- [ ] Conclusion is stated — not a file dump.
- [ ] Edge cases were checked (variants of the pattern, sibling dirs).

## When done → next skill

→ `noir-systematic-debugging` if this was for a bug hunt, or the skill that matches the resulting task.
