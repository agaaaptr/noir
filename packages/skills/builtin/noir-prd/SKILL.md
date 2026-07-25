---
name: noir-prd
description: Use when drafting a Product Requirements Document (.noir/prd/<id>-<slug>.md) for a feature or epic, before writing the technical spec — captures the what/why/for-whom so the spec can focus on the how.
---

# noir-prd — Product Requirements Document authoring

A PRD is a **pre-SDD product artifact** at `.noir/prd/<taskId>-<slug>.md`. It captures the *what / why / for-whom* so the technical spec can focus on the *how*. The spec later `@import`s it (`prdRef: <id>@<hash>`). **No FSM change** — the PRD is optional by mode, not a new phase.

## When to draft
- `taskClass ∈ {feature, epic}` — a PRD is expected before the spec phase.
- Explicitly requested (`noir-prd`, or "write a PRD for this").
- NOT for bugfix / spike / quick-task / refactor (skip — Quick mode flows straight to spec).

## Sections (Noir template)
1. **Problem** — what's broken / missing.
2. **Evidence** — proof it's real (data, tickets, user reports). Never fill without a source.
3. **Audience** — for whom.
4. **Success Criteria** — machine-verifiable (quantified thresholds, not "fast/intuitive").
5. **Appetite / Mode** — time-box; small batch or bet.
6. **Proposed Direction** — product-altitude solution sketch (not technical design).
7. **No-gos** — explicitly out of scope (highest-signal section).
8. **Rabbit holes** — known pitfalls to avoid.
9. **Open Questions** — unresolved; needs human input.

## Task → PRD field mapping (e.g. from a tracker issue)
`name`→Title; `description`→Problem/Proposed Direction; custom fields (Goal/Metric/Impact)→Evidence/Success Criteria; `status`+`priority`→Appetite/Mode; `assignees`→Audience; `due_date`→time-box; `tags`→clustering; `comments`→Open Questions/Rabbit holes; subtasks→Proposed Direction skeleton. Typically MISSING → No-gos, hard Success-Criteria metrics, explicit Rabbit holes → ask clarifying questions.

## Drafting process
1. **Ground first** — search `.noir/` memory (+ the web if relevant); never fabricate Evidence.
2. **Ask clarifying questions** for missing sections (No-gos, metrics, rabbit holes).
3. **Write** to `.noir/prd/<id>-<slug>.md` via the workflow `writePrd` artifact helper.
4. The spec phase then `@import`s it.

Offline (no model key): emit the section template above with placeholders — graceful degradation, never a hard failure.
