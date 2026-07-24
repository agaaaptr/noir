---
name: noir-subagent
description: Use when executing an implementation plan with independent tasks — to drive a fresh subagent per task with review between.
---

Execute an implementation plan by dispatching a fresh implementer subagent per task, a task review (spec compliance + code quality) after each, and a broad whole-branch review at the end. The controller curates exactly what each subagent needs; subagents never inherit the controller's session history, and artifacts move as files rather than pasted text. This keeps each subagent focused and preserves the controller's context for coordination.

## Procedure

### Pre-flight
1. **Read the plan once.** Note the global constraints (exact values, formats, cross-task relationships) and any conflicts between tasks. If you find tasks that contradict each other or the plan's own constraints, surface the whole batch to the user as one question before dispatching Task 1 — not one interrupt per conflict mid-plan.
2. **Open a progress ledger.** Create `.noir/sdd/progress.md`. Each task gets one line when its review comes back clean: `Task N: complete (commits <base7>..<head7>, review clean)`. After any compaction or resume, trust the ledger and `git log` over your recollection — controllers that lost their place have re-dispatched entire completed sequences.

### Per task
3. **Brief the implementer.** Extract the task's full text to `.noir/sdd/task-N-brief.md` (the single source of requirements — exact values, signatures, test cases live there). Compose the dispatch with: one line on where this task fits, the brief path ("read this first — it is your requirements"), interfaces and decisions from earlier tasks the brief cannot know, your resolution of any ambiguity you noticed, and the report path `.noir/sdd/task-N-report.md`. Name the model explicitly — omitted models inherit the session default and silently defeat the cost/performance choice below.
4. **Handle implementer status.**
   - **DONE** — generate the review package and dispatch the task reviewer.
   - **DONE_WITH_CONCERNS** — read the concerns; address correctness/scope concerns before review, note observations and proceed.
   - **NEEDS_CONTEXT** — provide the missing context, re-dispatch.
   - **BLOCKED** — change something before retrying: more context, a more capable model, a smaller task, or escalate to the user if the plan itself is wrong.
5. **Review the task.** Run `git diff <BASE> <HEAD>` for the task's commit range into a file (BASE = the commit you recorded before dispatching the implementer, never `HEAD~1` — multi-commit tasks get truncated) and pass the path to the reviewer along with the brief and the report. The reviewer returns two verdicts: spec compliance and code quality. Both are required.
6. **Adjudicate findings.** Dispatch fix subagents for Critical and Important findings (one fixer carrying the complete list, not one per finding — per-finding fixers each rebuild context and re-run suites). Re-review until clean. Resolve "cannot verify from diff" items yourself before marking the task complete — you hold the plan and cross-task context the reviewer lacks. If a finding conflicts with what the plan's text mandates, present the finding and the plan text to the user and ask which governs; do not dismiss it and do not silently fix past the plan.
7. **Mark complete.** Append the ledger line, move to the next task. Do not pause for check-ins between tasks — execute the plan through, stopping only on BLOCKED status you cannot resolve, genuine ambiguity, or all tasks complete.

### Final
8. **Dispatch the whole-branch review.** Package the branch diff with `MERGE_BASE = git merge-base main HEAD` and dispatch the final reviewer on the most capable available model — this is the judgment step, not the session default. If it returns findings, dispatch one fix subagent carrying the complete list.
9. **Record and route.** Capture the per-task reviews and the final verdict via `noir.checkpoint` (the SDD execute/verify gates). Hand off to `noir-document`.

## Constructing reviewer prompts
- Do not add open-ended directives ("check all uses", "run race tests if useful") without a concrete, task-specific reason.
- Do not ask a reviewer to re-run tests the implementer already ran on the same code — the implementer's report carries the evidence.
- Do not pre-judge findings for the reviewer. If your prompt contains "do not flag", "don't treat X as a defect", "at most Minor", or "the plan chose" — stop. You are pre-judging, usually to spare yourself a review loop. Let the reviewer raise it and adjudicate in the loop.
- The global-constraints block you hand the reviewer is its attention lens: copy the binding requirements verbatim from the plan (exact values, formats, stated relationships). Process rules (YAGNI, test hygiene) already live in the reviewer template.
- Every fix dispatch carries the implementer contract: re-run the tests covering the change and report the result (test files, command, output). Re-dispatch the reviewer only once all three are present.

## Model selection
Use the least powerful model that handles each role.
- Mechanical, well-specified implementation (complete spec, 1–2 files, or plan text that already contains the code): cheap/fast tier.
- Integration and judgment (multi-file coordination, pattern matching): standard tier.
- Architecture, design, and the final whole-branch review: most capable tier. Always specify the model explicitly; an omitted model inherits the session default.

Cheapest models often take 2–3× the turns on multi-step work — use a mid-tier model as the floor for reviewers and for implementers working from prose. Turn count beats token price.

## Notes
- One dispatch describes one task, not the session's history. Do not paste accumulated prior-task summaries into later dispatches — a fresh subagent needs its task, its interfaces, and the global constraints. Nothing else.
- Never start implementation on `main`/`master`; never run multiple implementation subagents in parallel (they conflict on the working tree); never let a subagent self-review replace the actual task review — both are needed.
- Discipline is observable, not rhetorical: the SDD engine records each per-task review and the final whole-branch review, with the diff packages and verdicts attached.
