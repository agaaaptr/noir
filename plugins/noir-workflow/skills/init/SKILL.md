---
name: init
description: One-time project bootstrap. Detects (never assumes) the real stack + existing structure, confirms with the user, scaffolds ONLY the gaps to the standard doc-layout (docs/{specs,plans,decisions,...}+DOC-POLICY.md, .session/, workflow/, CLAUDE.md/AGENTS.md), asks whether to adapt existing docs, and (if agentmemory) generates a memory-recall doc. Plugins are optional. Run once per project with /init.
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, AskUserQuestion, mcp__agentmemory__memory_recall, mcp__agentmemory__memory_save
---

Bootstrap a project. **Spine: Investigate → Confirm → Act.** Do not create or overwrite anything until the real setup is detected AND the user confirms.

## Procedure
0. **Mode.** Read `noir-workflow.mode` (`auto`/`rich`/`lean`) in `CLAUDE.md`/`AGENTS.md` (force if set). Else auto-detect per capability: **context-mode** (is `ctx_search` available?), **agentmemory** (`memory_recall`?), **superpowers** (`superpowers:brainstorming`?). Use the rich path per capability present, lean fallback for the rest. Never fail silently — say which fallback is active. (Full matrix + rules: the plugin's `references/modes.md`.)
1. **Detect (do not assume).** Scan root: docs (`CLAUDE.md`, `AGENTS.md`, `README.md`, `docs/`, `.notes/GUIDE.md`, `.claude/`), stack manifests (`go.mod` / `package.json` / `composer.json` / `angular.json` / `pom.xml` / …), build/test/run commands, `.gitignore`. Note anything non-conventional. Detail: `references/bootstrap.md`.
2. **Confirm.** Present detected setup + "existing I will NOT touch" + "gaps I will fill" via `AskUserQuestion`. Never overwrite a mature existing file without explicit confirmation.
3. **Existing docs?** If an existing doc structure or similar docs are found → ASK: (a) adapt to the standard, or (b) leave as-is and generate the standard alongside. (Standard docs are always generated.) See plugin `references/doc-structure.md`.
4. **Scaffold gaps** (from `templates/` + standard layout): `CLAUDE.md` / `AGENTS.md` (if missing), `.notes/GUIDE.md`, the standard `docs/{specs,plans,decisions,architecture,reference,handoffs,findings}/` + `docs/DOC-POLICY.md`, `.session/` (gitignored), `workflow/`. Add the superpowers override (specs → `docs/specs/`, plans → `docs/plans/`) to `AGENTS.md`/`CLAUDE.md`. Append gitignore entries. Detail: `references/bootstrap.md`.
5. **Memory-recall doc.** If agentmemory: `memory_recall` project memories → generate `docs/reference/project-memory.md` (memories + their recall queries). Lean (no agentmemory): ensure native `MEMORY.md` exists. Detail: `references/bootstrap.md`.
6. **Save memory** (if agentmemory, best-effort): the detected setup + stack (so `/sync`/`/flow` recall it next session).
7. **Report.** What was created / skipped, plugins present vs absent (optional), and suggest `/sync`.

## Fallbacks & confirms
- Plugins optional — never block on a missing plugin; note it.
- No agentmemory → skip the memory-recall doc; ensure `MEMORY.md`.
- Never overwrite/delete existing docs without explicit confirmation (the scan-step question).

## References
- plugin `references/modes.md`, `references/doc-structure.md`
- `references/bootstrap.md` — detect checklist, scaffold detail, DOC-POLICY template, memory-recall doc format
