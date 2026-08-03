---
name: task-starter
description: Use when starting a task or receiving a new task on this repo, to load the task-specific context (request, roadmap capability, codebase, spec, progress) before planning or implementing.
---

# Task Starter

Load the **task-level context** before planning or implementing a specific piece of work. This skill turns an ambiguous request into a focused, grounded understanding of what to build, what already exists, and what to watch out for.

> **Depends on:** [`session-starter`](../session-starter/SKILL.md). It loads the global project context once per session. This skill **reuses that context** — it does not re-read the whole roadmap.

## Step 0 — Identify the task (proactive)

If you were invoked for a task that has **not been explained yet**, do not start auditing on an assumption.

1. Check for an ongoing task: `/recall noir` (agentmemory) and `ctx_search` (context-mode) for recent/in-progress work.
2. **Ask the user** (via `AskUserQuestion` or the relevant tool) to confirm:
   - Is there an active task from the roadmap to continue, or a new task to start?
   - If continuing: what was the last checkpoint / state?
3. Only once the task is clear, proceed to audit. **Do not implement or plan before this is resolved.**

If the user described the task in the prompt, skip Step 0.

## Step 1 — Understand the request

Identify clearly, without assuming:
- **Objective** — what outcome is wanted.
- **Scope** — what is in / out of scope.
- **Target output** — deliverable shape (code, doc, spec, plan).
- **Constraints** — technical, time, architectural.
- **Dependencies** — on packages, capabilities, other tasks.
- **Affected codebase areas** — which packages/dirs.
- **Related roadmap capability** — which C# in `docs/roadmap/README.md`.

If anything is ambiguous, **collect all clarifying questions in ONE batch** and resolve them before continuing. Do not ask one-by-one.

## Step 2 — Audit the roadmap (reuse global context)

Use the context already loaded by `session-starter` (capability index, status, direction). Only read the specific capability doc(s) relevant to this task (`docs/roadmap/capability-NN-*.md`) — do not re-read the whole folder. Understand: objective, scope, dependency, acceptance criteria, roadmap status.

## Step 3 — Audit the codebase

Before proposing a solution:
- Scan the affected area (`grep` / directory walk).
- Understand current implementation.
- Identify **reusable components** — use them; avoid duplication.
- Identify **technical debt** and implementation constraints.
- Assess **regression risk**.

## Step 4 — Audit specs, ADRs, and progress

- **Specs / plans:** `docs/internal/specs/` and `docs/internal/plans/` (dated design specs + implementation plans) relevant to the area.
- **ADRs:** `docs/decisions/` for locked decisions.
- **Progress:** check agentmemory (`/recall`) + context-mode for what is done / in-flight / blocked, and the last checkpoint. Do not redo finished work.

## Step 5 — Research (only when a design decision exists)

Do research **only if** the task involves a design/architecture choice or new territory — not as a routine step for every task.
- Use web search with multiple sources (engineering blogs, official docs, RFCs, GitHub discussions).
- Synthesize, compare approaches, and note trade-offs.
- Treat roadmap examples as illustrations, not final designs — the final decision follows recent research + codebase reality.

## Step 6 — Gap analysis

Compare roadmap / spec / codebase / research to identify:
- Gaps between what is specified and what exists.
- Inconsistencies or technical debt.
- Implementation risks.

## Step 7 — Plan

Produce a focused plan (do not write code yet):
- Objective, affected files, implementation order.
- Testing strategy, rollback strategy.
- Documentation to update.
- Checkpoint to create.

For large changes, follow **spec-first**: create/update a specification before implementing (use `superpowers:brainstorming` / `superpowers:writing-plans` as reference for the flow). Do not skip straight to code.

## Step 8 — Confirm before implementing

Present the plan + any assumptions to the user and get confirmation before implementation. If this is an AFK/overnight session with default rules provided, use those rules for ambiguity and document the decisions taken.

## Notes

- **Future swap:** like `session-starter`, this skill uses the mature plugins (agentmemory, context-mode, superpowers) as context + workflow references. When Noir matures and is initialized in this repo, replace with Noir-native equivalents (`noir task status`, `noir context search`, `noir memory recall`, the SDD workflow engine).
- **Companion:** load [`session-starter`](../session-starter/SKILL.md) first if the global context is not already loaded this session.
