# TDD worked example — RED → GREEN → REFACTOR

Deep reference for `noir-test-driven-development`. A complete walkthrough of the loop on a real-shaped problem.

## The problem

Add a function that counts words in a string, ignoring punctuation and case.

## RED — write the failing test first

```ts
import { describe, expect, it } from 'vitest';
import { countWords } from './count-words.js';

describe('countWords', () => {
  it('counts simple words', () => {
    expect(countWords('hello world')).toBe(2);
  });
  it('ignores punctuation and is case-insensitive', () => {
    expect(countWords('Hello, WORLD!')).toBe(2);
  });
  it('returns 0 for empty/whitespace input', () => {
    expect(countWords('   ')).toBe(0);
  });
});
```

Run it. Expected: FAIL with `Cannot find module './count-words.js'` or `countWords is not a function` — the failure is because the feature doesn't exist, which is the RIGHT reason.

**Verify RED:** the failure is on your assertion / missing module, NOT on a broken import in the test itself.

## GREEN — minimal implementation

```ts
export function countWords(text: string): number {
  const words = text.toLowerCase().match(/[a-z]+/g);
  return words ? words.length : 0;
}
```

Run the test. PASS. Run the full suite — no regression.

**Verify GREEN:** it passes for the right reason (the regex matches words), not a coincidental edge case.

## REFACTOR — clean up with the green suite as a net

```ts
const WORD = /[a-z]+/g;
export function countWords(text: string): number {
  return text.toLowerCase().match(WORD)?.length ?? 0;
}
```

Run the suite again. Still green. The refactor is safe because the tests prove behavior.

## Repeat

Add the next behavior → back to RED. One test → one implementation → one refactor per cycle. Never skip RED: a feature without a failing test has no evidence it was needed.

## Anti-patterns this example guards against

- Writing the implementation before the test (no RED) — you can't prove the feature is needed.
- A test that passes before the implementation — you're not driving new behavior.
- Bundling a refactor into the GREEN step — the refactor belongs AFTER green.
- One test asserting five behaviors — split into five tests, each with one clear failure.
