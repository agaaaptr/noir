---
name: wrap
description: Close a work session cleanly. Runs the stack-detected test command, updates docs (API-CONTRACT/decisions/handoffs) to current state, curates docs (promote durable → permanent, delete ephemeral scratch, enforce naming — per doc-structure), checkpoints progress, commits per scope, and confirms push. Built-in tidy (replaces tidy-session-docs). Call from any /flow phase or at session end. Run /wrap.
user-invocable: true
allowed-tools: Bash, Read, Edit, Write, Glob, Grep, AskUserQuestion, mcp__agentmemory__memory_save
---

Close a session. **Spine: Investigate → Confirm → Act** — confirm what changed before claiming it's done.

## Procedure
0. **Mode + state.** **Mode.** Read `noir-workflow.mode` (`auto`/`rich`/`lean`) in `CLAUDE.md`/`AGENTS.md` (force if set). Else auto-detect per capability: **context-mode** (is `ctx_search` available?), **agentmemory** (`memory_recall`?), **superpowers** (`superpowers:brainstorming`?). Use the rich path per capability present, lean fallback for the rest. Never fail silently — say which fallback is active. (Full matrix + rules: the plugin's `references/modes.md`.) **State:** If `workflow/<task>.md` exists, read it for what was in progress.
1. **Investigate changes.** `git status` + `git diff --stat`. Identify which docs/contracts the session touched.
2. **Run tests.** Determine the test cmd from `CLAUDE.md` / manifest; run it; show output. If fail → STOP + report (no false success).
3. **Update docs to current state.** From the diff, update `API-CONTRACT.md` / `docs/decisions/` / `docs/handoffs/` so docs are accurate after this session. Confirm scope with the user if unclear.
4. **Curate docs (built-in tidy).** Per plugin `references/doc-structure.md` — see `references/curation.md`: promote durable ephemeral content → permanent, delete the rest (`.session/`, `.superpowers/sdd/` contents), enforce naming, verify accuracy (don't keep garbage), protect permanent. **Confirm the promote/delete list with the user before acting.**
5. **Checkpoint.** Update `workflow/<task>.md` (status, done/next). If agentmemory, `memory_save` (best-effort).
6. **Commit per scope; confirm push.** Commit each logical scope (conventional commits). Per plugin `references/commit-push.md`: **confirm push** with the user; CI-aware post-push action (no assumption).
7. **Report.** Test result (evidence), docs updated, promoted/deleted, checkpoint location, commits, push status, unfinished work.

## Hard rules
- Never claim tests pass without showing output.
- Never delete permanent docs (`docs/{specs,plans,decisions,architecture,reference,handoffs,findings}/`, `DOC-POLICY.md`) — only promote-then-delete ephemeral, with user confirmation.
- Push = explicit confirm.

## References
- plugin `references/modes.md`, `references/commit-push.md`, `references/doc-structure.md`
- `references/curation.md` — curation logic (promote/delete/naming/accuracy)
