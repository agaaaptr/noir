---
name: noir-test
description: Use when writing tests — for test design, coverage, and edge cases (not just running them).
---

# noir-test

> **Stub:** this skill ships as a valid, loadable placeholder in S5; its full playbook is deepened in a later slice.

**When to use:** you are writing tests and want them to actually catch bugs — design and coverage, not just running a suite.

**For now:** name each test for a behavior, cover the happy path plus the null/empty/boundary/error cases, and assert on observable outcomes rather than internals.
