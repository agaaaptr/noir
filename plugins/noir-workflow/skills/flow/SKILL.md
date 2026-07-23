---
name: flow
description: The orchestrated AI dev loop for ONE task — 8 phases with human review gates (Context → Intake → Investigate → Clarify&Confirm [HARD gate] → Plan → Execute → Verify → Document). ClickUp or no-ID intake; delegates Plan/Execute to Superpowers (rich) or inlines lean phases; persists state to workflow/<task>.md so work survives context loss. Run /flow <clickup-id> or /flow (no ID → intake prompt).
user-invocable: true
allowed-tools: Read, Write, Edit, Bash, Glob, Grep, Skill, Agent, AskUserQuestion, WebFetch, mcp__plugin_context-mode_context-mode__ctx_search, mcp__agentmemory__memory_recall, mcp__agentmemory__memory_save
---

Orchestrator. **Spine (HARD): Investigate → Confirm → Act.** No execution before facts are gathered AND the user confirms at the phase-3 gate; on later doubt, return there. Persist state **every phase** to `workflow/<task>.md` (template `templates/workflow-state.md.tpl`) — the context-loss survivor.

**Resume:** if `workflow/<task>.md` exists, read its `phase:` and resume there (re-run `/sync` first). Otherwise start at phase 0.

## Procedure
0. **Context + mode.** Invoke `/sync`. **Mode.** Read `noir-workflow.mode` (`auto`/`rich`/`lean`) in `CLAUDE.md`/`AGENTS.md` (force if set). Else auto-detect per capability: **context-mode** (is `ctx_search` available?), **agentmemory** (`memory_recall`?), **superpowers** (`superpowers:brainstorming`?). Use the rich path per capability present, lean fallback for the rest. Never fail silently — say which fallback is active. (Full matrix + rules: the plugin's `references/modes.md`.)
1. **Intake.** ClickUp id → fetch; no id → `AskUserQuestion` the intake template. See `references/intake.md`. Create `workflow/<task>.md`; fill task + acceptance criteria; flag blanks for phase-3. Gate: task understood.
2. **Investigate.** Rich: dispatch a subagent (FACTS only). Lean: explore inline, keep a concise summary. Record in state file. Gate: user reviews facts.
3. **Clarify & Confirm (HARD GATE).** List every question + assumption; `AskUserQuestion` to resolve. Print **My understanding:** (task, approach, files, conventions). **Do not proceed until the user confirms.** Save Q&A to state file + memory (best-effort; state file is source of truth).
4. **Plan.** Rich: `superpowers:brainstorming` → `superpowers:writing-plans`. Lean: inline spec + plan. Write spec → `docs/specs/`, plan → `docs/plans/` (NOT `docs/superpowers/`). Record paths in state file. Gate: user approves.
5. **Execute.** State the binding rule: *commit per scope (conventional commits); never bundle unrelated changes*. Rich: `superpowers:executing-plans` (TDD, checkpoints). Lean: execute inline, TDD where the stack supports it, commit per scope. Update state file per task. On doubt → back to phase-3. Gate: per-checkpoint review.
6. **Verify.** Run the stack-detected test command; capture + show output as evidence. Gate: user accepts.
7. **Document + release.** Update `API-CONTRACT.md` / `docs/decisions/` / `docs/handoffs/`. (Doc tidy is `/wrap`'s job.) Then per plugin `references/commit-push.md`: commit → **confirm push** → push, with the **CI-aware post-push** action (Angular `@uiigateway/*` lib → offer version-bump + tag via `references/release.md`; auto-deploy BE → no tag). Set state `status: done`. Gate: docs reviewed.

**Checkpoint (any phase, on interrupt / end):** save progress to `workflow/<task>.md` (always) + memory if agentmemory (best-effort). See `references/phases.md`.

## Hard rules
- No execution before phase-3 Confirm.
- Update `workflow/<task>.md` every phase.
- On doubt → back to Confirm.
- Commit per scope; **push = explicit confirm** (plugin `references/commit-push.md`).
- Rich = delegate to Superpowers (don't reimplement); lean = inline.

## References
- plugin `references/modes.md`, `references/commit-push.md`, `references/doc-structure.md`
- `references/intake.md` — ClickUp fetch + no-ID intake template
- `references/release.md` — Angular version-bump + counter + CHANGELOG + tag
- `references/phases.md` — 2-mode investigate/plan/execute detail + checkpoint
