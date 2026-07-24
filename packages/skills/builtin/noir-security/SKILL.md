---
name: noir-security
description: Use when reviewing changes for security vulnerabilities — injection, auth, SSRF, data exposure.
---

# noir-security

> **Stub:** this skill ships as a valid, loadable placeholder in S5; its full playbook is deepened in a later slice.

**When to use:** you are reviewing a change and want to check it for the common, exploitable classes before merging.

**For now:** scan for injection (SQL/command/template), broken auth and authz, SSRF in any outbound call, and sensitive data in logs or responses — flag concretely, do not rubber-stamp.
