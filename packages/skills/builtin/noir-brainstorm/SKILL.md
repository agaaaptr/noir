---
name: noir-brainstorm
description: Use before any creative work — creating features, building components, or adding functionality — to explore intent, requirements, and design before implementation.
---

Explore the user's intent, requirements, and design space before writing any code or plan. The goal is a shared, written understanding — not a shortcut to the first plausible build.

## Procedure
1. **Restate the goal.** In one sentence, say what the user is trying to achieve and why.
2. **Surface requirements.** Ask clarifying questions (one batch) about scope, constraints, users, and non-goals. Prefer a structured prompt when the answers are constrained choices.
3. **Explore options.** Offer 2–3 distinct approaches with explicit trade-offs; do not collapse to a single path prematurely.
4. **Record decisions.** Capture the chosen direction and any open questions as a spec stub under `.noir/specs/`. `noir-spec` deepens it; the SDD engine records the brainstorm checkpoint observably.
5. **Hand off.** Point to `noir-spec`, then `noir-plan`.

## Notes
- Discipline is observable, not rhetorical — the SDD engine's gates record that brainstorming happened. This skill is the playbook.
- For a trivial one-liner, say so and skip; brainstorming is for genuinely creative or ambiguous work.
