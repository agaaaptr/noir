---
name: noir-explore
description: Use when answering means sweeping many files, directories, or naming conventions — to fan out read-only search and return the conclusion, not the file dumps.
---

Locate code across the codebase without reading every file into context. Prefer a read-only search fan-out that returns locations and a short conclusion; read whole files only for the few you actually need to edit.

## Procedure
1. **Frame the question.** State precisely what you are looking for — a symbol, a pattern, a naming convention, or where something is defined. A fuzzy query yields a fuzzy sweep.
2. **Fan out.** Use `grep` / `glob`, or dispatch a read-only search subagent across the likely locations. State the search breadth up front (medium for a focused module, very thorough for cross-package naming or convention questions).
3. **Return the conclusion.** Summarize where things live with `file:line` references and the one-line gist of each match — not the raw matched lines. Call out conventions discovered (e.g. "errors are thrown in `src/errors/`, not at call sites").
4. **Read targeted.** Open only the specific files or line ranges you need to act on. Everything else stays a citation.

## Notes
- Keep raw search output out of context where possible — process it in a sandbox or subagent and surface only the derived answer. Large `grep` dumps cost context for the rest of the session.
- This skill locates code — it does not review, audit, or refactor it. Hand to `noir-review` for judgment on what you found.
