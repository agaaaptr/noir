# Verification checklist — evidence before "done"

Deep reference for `noir-verifying`. A copyable checklist for the two moments it covers: claiming a task done, and reviewing a PR.

## The claim-done gate

Before asserting "this is done," satisfy EVERY item with evidence:

- [ ] **Spec criteria met** — every acceptance criterion from the spec/plan is citable to an actual behavior, test, or output. Not "looks implemented" — point to the evidence.
- [ ] **Tests green** — the full suite passes. The OUTPUT was read, not assumed. Quote the result line.
- [ ] **No regression** — tests that passed before still pass. A green suite isn't enough if you deleted a test to make it green.
- [ ] **Lint/typecheck** — the project's static checks pass (e.g. `pnpm lint`, `pnpm typecheck`).
- [ ] **Side effects checked** — docs, generated files, or config that the change touches reflect the new reality (docs reflect shipped state, never stale).
- [ ] **The claim is evidence-backed** — "verified: <test output / command result>" not "verified: looks good."

## The PR-review gate

Beyond the claim-done gate, review asks "does this make sense?"

- [ ] **Approach** — is this the right way to solve it, or a workaround?
- [ ] **Naming** — do names say what things are?
- [ ] **Scope** — does the PR do one thing, or did "while I'm here" changes creep in?
- [ ] **Security** — user input, auth, secrets: any exposure?
- [ ] **Tests** — do the tests test the behavior, not the implementation detail?
- [ ] **Diff hygiene** — no commented-out code, no debug logs, no accidental files.

## The honesty rule

**"Seems right" is never sufficient.** State the evidence and let it stand on its own. If you cannot produce evidence for an item, the item is NOT done — say so, rather than asserting completion. The same discipline that keeps a debugging trace honest keeps a "done" claim honest.
