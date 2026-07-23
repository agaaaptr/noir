# /flow Phase 1 — Intake (ClickUp or no-ID)

## With a ClickUp id
The Bash tool runs a **non-interactive shell that does NOT source `~/.zshrc`** — load the token explicitly first:
```bash
source ~/.zshrc >/dev/null 2>&1
```
If `$CLICKUP_API_TOKEN` is now set, fetch:
```bash
curl -s -H "Authorization: $CLICKUP_API_TOKEN" "https://api.clickup.com/api/v2/task/<task_id>"
```
(custom id: add `?custom_task_ids=true&team_id=$CLICKUP_TEAM_ID`; strip the leading `#`.)
If the token is still unset or the fetch fails (HTTP 400/401) → use the **no-ID intake** below.

## No ClickUp id (or fetch failed) — intake template
Use `AskUserQuestion` / prompt the user to fill (or describe freely; extract into the fields):

```
- Title: <short>
- Objective (tujuan): <outcome/goal — why it matters>
- Problem / Need: <current pain or gap>
- Requirements: <functional + non-functional>
- Constraints: <stack, compat, deadline, policy, deps>
- Scope: IN <…> / OUT <…>
- Non-goals: <explicitly NOT doing>
- Acceptance criteria: <testable "done when…">
- Context / Background: <related systems, history, links>
- Priority / Urgency: <critical/high/medium/low + deadline>
- References: <people, docs, repos, tickets>
- Open questions / Assumptions: <flagged for phase-3 clarify>
```

This is the canonical intake shape (a ClickUp task maps onto the same fields). **Empty fields → flag for phase-3 clarification — never assume scope.**
