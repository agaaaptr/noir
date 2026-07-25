---
name: noir-rules
description: Use when reviewing or editing the project's AI working-rules (.noir/rules/RULES.md), or when deciding whether a directive belongs in the always-on contract vs a skill, a memory, or an ADR.
---

# noir-rules — AI working-rules steward

The project's canonical AI working-contract lives at `.noir/rules/RULES.md`; the host context file (`CLAUDE.md`) `@import`s it so it is in context every session. Noir re-emits only the `@import` pointer on `noir init`/`noir sync` — the body is user-owned.

## When to use
- Editing or reviewing `.noir/rules/RULES.md`.
- Deciding where a directive belongs:
  - **rules** — always-on contract (loaded every session);
  - **skill** — on-demand playbook (loaded when triggered);
  - **memory** — a learned fact/decision (recall on demand);
  - **ADR** — a locked architecture decision (`.noir/decisions/NNNN-*.md`).

## Keeping rules lean — the pruning rubric
Every line pays rent in every session's context budget. Keep a line only if it is one of:
- **failure-backed** — it prevented a real issue in the last 30 days; or
- **tool-enforceable** — a command / hook / gate checks it; or
- **decision-encoding** — records a locked architecture/workflow choice; or
- **triggerable** — names a specific condition for action.

Otherwise delete it. "Document failures, not aspirations."

## Recommended structure (section order)
Identity & scope → Anti-assumption contract → SDD workflow gates → Verification commands → Coding standards (link ADRs, don't inline) → Docs & roadmap pointers → Conventions gotchas.

## Budget
Target ≤ 150 lines / ≤ 6 KB. Effective attention degrades in the low-thousands of tokens regardless of window size — every line must earn its place.

## Multi-host (v1.x)
`RULES.md` is AGENTS.md-compatible. For non-Claude hosts, `noir sync` emits a root `AGENTS.md` that imports it; Cursor additionally compiles to `.cursor/rules/*.mdc` with `description`/`globs`/`alwaysApply` frontmatter.
