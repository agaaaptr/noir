# Noir Master Development Roadmap

> **Status:** Active
> **Version:** v1.x (current stable 1.9.0)
> **Scope:** Long-term engineering direction
> **Methodology:** Spec-Driven Development (SDD)
> **Owner:** Core Engineering

This is the **master strategic roadmap** for the Noir project. It is the single source of truth for *direction* — not a TODO list, and not an implementation plan. Every development effort must trace back to this document (via a capability doc and its specification).

It defines: the project vision, development direction, capabilities, priorities, engineering principles, governance, implementation rules, and maintenance strategy.

The capability index, philosophy, lifecycle, and dependency graph live in [`README.md`](README.md) — the single canonical source. This document carries the strategy on top of them.

---

## Vision

Noir aims to be a **standalone, AI-native, host-agnostic AI development platform**. It does not depend on any single AI host; it works alongside the modern agentic CLIs (Claude Code, Gemini CLI, Codex, Cursor, OpenHands, Windsurf, and hosts that will appear later).

Noir adopts the best ideas from modern AI tools **without copying their implementations**:

> **Adopt ideas, not copies.**

**What Noir is today** (grounded, 2026-08): a spec-driven-workflow + native-context + cross-session-memory **layer** for agentic CLIs — 11 packages, a local daemon, 5 host adapters, 26 builtin skills + 1 integration, hybrid retrieval, bounded model, and a release pipeline. It is **not** an LLM runtime (bring your own agent). See [`releases.md`](releases.md) for the shipped record.

---

## Engineering principles

The authoritative canonical list is in [`README.md`](README.md) (# Philosophy). Highlights that shape every decision:

- **AI first** — features consider the AI as a primary user.
- **Spec-driven development** — implementation always starts from a requirement → research → specification → planning → review → implementation → validation → documentation → release. **No spec, no implementation.**
- **Documentation first** — documentation is part of engineering, not an afterthought.
- **Single source of truth** — information lives once; other files reference, never copy.
- **Automation first**, **convention over configuration**, **progressive enhancement**, **modular architecture**, **idempotent commands**, **backward compatibility** (breaking changes documented + migrated).

---

## Development methodology

Spec-Driven Development (SDD) is the working method:

```text
Research → Capability → Epic → Specification → Planning → Slice
    → Implementation → Validation → Checkpoint → Documentation → Release
```

**Research is mandatory** before specification or implementation. For every capability: web search across multiple sources, study engineering issues/RFCs/design proposals/blogs/open-source repos, synthesize. Never decide from experience alone.

---

## Governance

Governance is a capability of its own — see [`capability-07-engineering-governance.md`](capability-07-engineering-governance.md). In short:

- **Architecture decisions** are recorded as ADRs in `docs/decisions/` (append-only; supersede, never rewrite).
- **Specs and plans** live in `docs/internal/{specs,plans}` (dogfooded on this repo).
- **CI gates** (lint/build/typecheck/test/docs:validate) run on every push/PR.
- **Releases** follow the runbook in `docs/how-to/releasing.md` (two channels, SLSA provenance, idempotent).

---

## Project cleanup before new development phases

Before starting a new development phase, audit the repository: source, documentation, specifications, roadmap, plans, assets, temp/scratch/backup/generated files, unused directories. Identify stale/obsolete/duplicate/superseded documents, broken references, inconsistent or orphan documentation. Do **not** delete documents that are still referenced; mark uncertain ones for review. Produce a cleanup report (deleted files + reasons, kept files, review candidates, debt found). Cleanup is **conservative** — never delete without confirming something is truly unused.

---

## Rules for architecture & implementation

- **Examples on this roadmap are not final designs.** Directory structures, file names, lifecycles, workflows, diagrams, command examples, config examples — all are illustrative. Do not adopt them as the final implementation automatically.
- **Research before decision** — compare approaches across credible sources, synthesize, then recommend.
- **Existing codebase has higher priority** — analyze the current implementation before proposing architectural change; prefer evolution over rewrite.
- **Prefer evolution over rewrite** — rewrite only when the benefit clearly outweighs the migration cost.
- **Don't follow trends without analysis** — Noir must not copy other tools' designs (Claude Code, Gemini CLI, Cursor, Cline, OpenHands, Codex, Windsurf, Aider each have different philosophy/architecture/constraints). Study their approaches, understand the design rationale, identify trade-offs, synthesize, adopt only what is relevant.
- **Documentation must reflect reality** — when implementation changes, update the relevant docs at the same checkpoint. No documentation drift between roadmap, specification, implementation, and codebase.
- **Source of truth** — when the same info appears in several docs, one is primary; the others reference, not copy.
- **Continuous validation** — roadmap, specs, workflows, and docs are evaluated periodically; update the roadmap when research or the ecosystem improves on a current approach, without losing architectural consistency.

---

## Research references

Prioritize references such as GitHub Engineering, Google/Microsoft/Stripe/Netflix/Uber/Cloudflare Engineering, Vercel, Anthropic, OpenAI, Kubernetes, Rust, Go, Bun, Deno, uv, Nx, Turborepo, Continue.dev, OpenHands, Roo Code, Cline, Windsurf, Cursor, Gemini CLI, Claude Code. Use multiple distinct sources; never one.

Each research effort should produce: a summary, a reference list, an approach comparison, trade-offs, risks, recommendations, and design decisions. Each engineering decision must have a documented rationale (benefits, drawbacks, impact, complexity, maintenance, extensibility).
