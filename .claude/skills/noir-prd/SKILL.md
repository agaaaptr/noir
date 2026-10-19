---
name: noir-prd
description: Use when drafting a Product Requirements Document — capturing what a feature does, why it matters, and who it serves before the technical spec. Do NOT use for the technical "how" — that's noir-spec.
metadata:
  category: plan
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-prd

A PRD captures what and why before the spec captures how. It is the user-facing contract — who this feature is for, what problem it solves, and what success looks like. Shorter than a spec and never technical.

## When to use

- A feature needs stakeholder-facing rationale before a technical spec.
- The user says "write a PRD", "why are we building this", "who is this for."
- After `noir-brainstorming` when the idea is clear but needs a formal "why."
- **Do NOT use:** for the technical implementation plan — that's `noir-planning`.

## Procedure

1. **Confirm the "why" exists.** A PRD with no evidence behind it is fiction. Gather from the `noir-brainstorming` output or the task brief; if there is no data, ticket, or user report, collect that before drafting.
2. **Confirm it's wanted.** Explicit opt-in — never auto-draft a PRD; ask first.
3. **Fill the sections below.** On Claude Code, use `AskUserQuestion` to close gaps (who is the user, what metric); on other hosts, ask in text. Never invent an answer to close a gap.
4. **Write to** `.noir/prd/PRD-<NNNN>-<taskId>-<slug>.md`.

## Sections (Noir template)

1. **Problem.** What problem does this solve? For whom?
2. **Evidence.** Proof it's real — data, tickets, user reports. Never fabricate; cite a source.
3. **Audience.** For whom.
4. **Success Criteria.** Machine-verifiable thresholds — not adjectives.
5. **Appetite / Mode.** Time-box; small batch or bet.
6. **Proposed Direction.** Product-altitude solution sketch — not the technical design.
7. **No-gos.** Explicitly out of scope.
8. **Rabbit holes.** Known pitfalls to avoid.
9. **Open Questions.** Unresolved items that need human input.

## When done → next skill

→ `noir-spec` to formalize the technical side. Or is there something else?

## Notes
- This skill is a playbook — the host decides which tools to use.
