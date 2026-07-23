---
name: sync
description: Load + index project context at session start (explicit, read-only, idempotent). Detects mode, reads anchors + git state, indexes big docs (rich) or notes key files (lean), recalls memory, prints an essential-info brief (project type, stack, key config, commands — no large dumps). Run /sync at session start or for a refresher.
user-invocable: true
allowed-tools: Read, Bash, Glob, Grep, mcp__plugin_context-mode_context-mode__ctx_index, mcp__plugin_context-mode_context-mode__ctx_search, mcp__agentmemory__memory_recall, mcp__agentmemory__memory_smart_search
---

Load project context. **Read-only** — do not edit project files. Spine: Investigate → Confirm (report setup) → Act (none).

## Procedure
0. **Mode.** Read `noir-workflow.mode` (`auto`/`rich`/`lean`) in `CLAUDE.md`/`AGENTS.md` (force if set). Else auto-detect per capability: **context-mode** (is `ctx_search` available?), **agentmemory** (`memory_recall`?), **superpowers** (`superpowers:brainstorming`?). Use the rich path per capability present, lean fallback for the rest. Never fail silently — say which fallback is active. (Full matrix + rules: the plugin's `references/modes.md`.)
1. **Read anchors.** Read `CLAUDE.md` + `AGENTS.md` (always-on; re-read to ground the brief).
2. **Index/scan knowledge (JIT — keep it OUT of context).** Rich (context-mode): `ctx_index` `.notes/GUIDE.md` + `docs/`. Lean (no context-mode): note the key doc paths only — do not dump; `ctx_search` if a prior session captured the KB, else flag "scan on demand". Detail: `references/procedure.md`.
3. **Git state.** `git rev-parse --abbrev-ref HEAD` ; `git status --porcelain` ; `git log --oneline -3`.
4. **Detect + report setup.** Stack + test/run cmd (manifests / `CLAUDE.md`); project type (BE / FE). Flag non-conventional. Informational — no mutation.
5. **Recall memory (resilient).** Rich (agentmemory): `memory_recall` / `smart_search`; **if empty**, fall back to `ctx_search` + native `MEMORY.md`. Lean: `MEMORY.md` only. Surface 2–4 top facts.
6. **In-progress work.** If `workflow/` has `<task>.md`, surface its phase + a resume hint.
7. **Published versions (Angular v13 `@uiigateway/*` lib only).** Run `npm run versions` if present, else `npm view <pkg> versions --json` → latest-per-env. Skip silently otherwise.
8. **Print the brief** (essential info only — fields in `references/procedure.md`). Then await the user — do not auto-start.

## Fallbacks & confirms
- Missing plugin → use the lean branch AND tell the user (e.g. "context-mode absent — scanning key files instead"). See plugin `references/modes.md`.
- No memory found → say so; the durable record is always `workflow/<task>.md`.

## References
- plugin `references/modes.md` — mode detection + degradation
- `references/procedure.md` — detailed steps, indexing/recall fallbacks, brief fields
