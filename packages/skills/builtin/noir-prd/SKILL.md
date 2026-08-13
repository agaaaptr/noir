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

## Procedure
1. **Follow the guidance** in the notes and verification.

- A feature needs stakeholder-facing rationale before a technical spec.
- The user says "write a PRD", "why are we building this", "who is this for."
- After `noir-brainstorming` when the idea is clear but needs a formal "why."
- **Do NOT use:** for the technical implementation plan — that's `noir-planning`.

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

## Drafting

1. Gather from brainstorming output or the task brief.
2. On Claude Code, use `AskUserQuestion` to fill gaps (who is the user, what metric). On other hosts, ask.
3. Write to `.noir/prd/PRD-<NNNN>-<taskId>-<slug>.md`.
4. **Explicit opt-in.** Never auto-draft a PRD — ask first.

## When done → next skill

→ `noir-spec` to formalize the technical side. Or is there something else?

## Notes
- This skill is a playbook — the host decides which tools to use.
