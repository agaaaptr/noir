# Builtin Skills

> Auto-generated from `packages/skills/builtin/*/SKILL.md` and `integrations/*/SKILL.md`.

**34 skills** (33 builtins + 1 integrations)

| Skill | Type | Description |
|---|---|---|
| `noir-backend` | builtin | Use when building APIs, database schemas, or server logic — for robust, scalable backend patterns. |
| `noir-brainstorm` | builtin | Use before any creative work — creating features, building components, or adding functionality — to explore intent, requirements, and design before implementation. |
| `noir-branch` | builtin | Use when implementation is complete and tests pass — to decide how to integrate (merge, PR, or cleanup). |
| `noir-checkpoint` | builtin | Use mid-session — to save in-flight state before a context-risky moment or interruption, so work survives. |
| `noir-clarify` | builtin | Use when an idea or spec has ambiguities — to surface and resolve open questions before committing to an approach. |
| `noir-clickup` | integration | Use when a task comes from or writes back to ClickUp — to read a task by id, update status, create subtasks, post a comment, or batch-create tasks from an H2-per-task markdown list; routes writes through the noir_clickup_write gated proxy and reads via the host fetch with the pk_ token resolved by integrations_auth. |
| `noir-commit` | builtin | Use when creating a git commit — to scope changes logically and write a conventional-commit message. |
| `noir-context` | builtin | Use when a question spans more files than fit in context — to seed the repo into a hybrid index once, then query it for windowed snippets instead of reading whole files. |
| `noir-debug` | builtin | Use when encountering any bug, test failure, or unexpected behavior — before proposing a fix. |
| `noir-doctor` | builtin | Use when diagnosing environment or project health — deps, config, runtime, toolchain. |
| `noir-document` | builtin | Use when closing a work session — to update docs, CHANGELOG, decisions, and memory before wrapping up. |
| `noir-execute` | builtin | Use when executing a written implementation plan, task by task — driving the SDD execute phase. |
| `noir-explore` | builtin | Use when answering means sweeping many files, directories, or naming conventions — to fan out read-only search and return the conclusion, not the file dumps. |
| `noir-frontend` | builtin | Use when building or reshaping UI — for distinctive visual design, typography, and component patterns. |
| `noir-intake` | builtin | Use when starting a new feature or task from a raw idea, ticket, or issue — before any design or code. |
| `noir-parallel` | builtin | Use when facing two or more independent tasks with no shared state or ordering — to work them concurrently. |
| `noir-plan` | builtin | Use when you have an approved spec and need a step-by-step implementation plan — before touching code. |
| `noir-pr` | builtin | Use when committing, pushing, and opening a pull request in one flow. |
| `noir-prd` | builtin | Use when drafting a Product Requirements Document (.noir/prd/<id>-<slug>.md) for a feature or epic, before writing the technical spec — captures the what/why/for-whom so the spec can focus on the how. |
| `noir-readme` | builtin | Use when generating or updating a README or docs from the codebase. |
| `noir-recall` | builtin | Use when starting a task, before re-deriving something that may already be known — to recall a prior decision, pattern, bug, or fact from Noir's cross-session memory. |
| `noir-remember` | builtin | Use when an insight, decision, pattern, or bug worth keeping surfaces, or the user says "remember this" / "save this" — to persist it to Noir's cross-session memory. |
| `noir-review` | builtin | Use when completing a task or before merging — to verify the work meets its requirements. |
| `noir-rules` | builtin | Use when reviewing or editing the project's AI working-rules (.noir/rules/RULES.md), or when deciding whether a directive belongs in the always-on contract vs a skill, a memory, or an ADR. |
| `noir-security` | builtin | Use when reviewing changes for security vulnerabilities — injection, auth, SSRF, data exposure. |
| `noir-skill-author` | builtin | Use when creating new skills or editing existing ones — TDD for process docs. |
| `noir-spec` | builtin | Use when turning a brainstormed idea into a formal spec (what / why / acceptance / non-goals) — before planning or code. |
| `noir-subagent` | builtin | Use when executing an implementation plan with independent tasks — to drive a fresh subagent per task with review between. |
| `noir-sync` | builtin | Use at the start of a session — to load project context (anchors, git state, setup) and recall prior memory before doing anything else. |
| `noir-tdd` | builtin | Use when implementing any feature or bugfix — to write the failing test before the implementation. |
| `noir-test` | builtin | Use when writing tests — for test design, coverage, and edge cases (not just running them). |
| `noir-verify` | builtin | Use when about to claim work is complete or fixed — to run verification and gather evidence before asserting success. |
| `noir-worktree` | builtin | Use when starting feature work that needs isolation from the current workspace. |
| `noir-wrap` | builtin | Use when closing a session cleanly — run tests, curate docs, confirm commits, save memory, emit a host handoff. |
