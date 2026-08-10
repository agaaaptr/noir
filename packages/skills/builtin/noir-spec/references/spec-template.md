# Spec template — the what/why/acceptance/non-goals skeleton

Deep reference for `noir-spec`. A copyable skeleton for a formal specification. Keep it short and sharp; a spec is a contract, not a novel.

```markdown
# <Feature> — specification

## Goal
One sentence: what are we building and why.

## Scope (in)
- The concrete capabilities this build delivers.

## Non-goals (out)
- What we are deliberately NOT building in this version.

## Users / personas
- Who this is for.

## Acceptance criteria
- [ ] Concrete, verifiable "done when" statements.
- [ ] Each one is testable (behavior, number, or screen).
- [ ] No vague acceptances like "works well" or "feels fast".

## Constraints
- Technical, timeline, dependency, or architectural limits that bind the implementation.

## Open questions
- Anything still unknown; resolved before planning if possible.
```

## Authoring rules

1. **Goal first, one sentence.** If the goal needs two sentences, it's two features.
2. **Acceptance criteria are the contract.** The implementation plan maps each criterion to a task; the verify gate checks each one. Write them so a reader can check them off without asking you.
3. **Non-goals prevent scope creep.** "We are not doing X" is as important as "we are doing Y."
4. **A short spec with sharp boundaries beats a long essay.** 10 crisp lines > 200 fuzzy ones.
5. **Reference sibling specs** when this builds on another — don't copy-paste its content.

## Good / bad

Good: "Acceptance — the CLI accepts `--json` and emits a versioned `{ok, data}` envelope to stdout, empty otherwise; exit 0 on success, non-zero on failure."
Bad: "Acceptance — it should work properly and be user friendly."
