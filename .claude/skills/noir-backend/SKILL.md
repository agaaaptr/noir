---
name: noir-backend
description: Use when building backend code — APIs, database schemas, server logic, and scalable backend patterns. Do NOT use for pure frontend work.
metadata:
  category: domain
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
references:
  - backend-patterns.md
---

# noir-backend

Backend architecture and implementation — APIs, databases, services, and server patterns.

## When to use

- Building or modifying backend code.
- The user says "create an API", "add an endpoint", "design a schema", "set up a service."
- A service boundary or data flow is being defined.

## Procedure

1. **Design the contract first.** What does the API accept and return? What's the schema? The contract is the interface — implementers on both sides read it.
2. **One endpoint = one responsibility.** Small, focused handlers are testable; monolithic "do-everything" endpoints are not.
3. **Error handling at every layer.** API → validation → service → database. Each layer reports a structured error; the client never sees a raw stack trace.
4. **Database migrations.** Schema changes go through migration files — never alter a table by hand. Rollback must be possible.
5. **Security.** Auth on every endpoint that touches data; rate-limit write endpoints; validate input at the boundary.

## Reference

For contract-first, layered error handling, migrations, and resilience patterns, see [backend-patterns.md](references/backend-patterns.md).

## When done → next skill

→ `noir-test-driven-development` for the test suite, then `noir-verifying`.

## Notes
- This skill is a playbook — the host decides which tools to use. On Claude Code, prefer `AskUserQuestion` for choices; on other hosts, ask in text.
