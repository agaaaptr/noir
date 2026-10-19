# Bug bash

A focused QA pass over an app or a branch. Every finding is proven by a repro
test, not a note.

## Pass

1. Pick the scope: a feature, a screen, or the whole app.
2. Drive each flow as a user, including the failure paths: empty forms, double
   submits, invalid input, back and forward.
3. For each defect found, write a minimal test that reproduces it, then commit
   the repro with the fix (or open the issue with the repro attached).

## Rules

- A finding without a repro is a rumor. Pin it.
- Test the failure path, not only the happy path.
- A planted or known bug is never silently fixed; it is either fixed with its
  repro or reported.
