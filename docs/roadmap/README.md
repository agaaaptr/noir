# Noir Roadmap

> **Living roadmap.** This directory is the single source of truth for Noir's long-term development direction as an **AI-native, host-agnostic, spec-driven engineering platform**. It defines *where Noir is headed and why* — it is **not** an implementation backlog.

- **Where Noir is today:** [`releases.md`](releases.md) (shipped status, release history, version targets) + [`STATUS.md`](STATUS.md) (per-capability progress).
- **What is deferred:** [`backlog.md`](backlog.md) (consolidated engineering debt).
- **Origin / detailed rationale:** `docs/internal/specs/2026-07-23-noir-toolkit-design.md`.
- **Decisions of record:** `docs/decisions/` (ADR `0001`…`0007`).

Every capability on this roadmap must go through the project lifecycle before implementation — **research → analysis → architecture proposal → specification → planning → slice → implementation → validation → documentation → checkpoint → release**. Implementation is never done directly from the roadmap alone; the spec derived from it is the reference.

---

## Philosophy

Noir is built on these principles (one canonical list — capability docs reference this, they do not restate it):

- **Spec before implementation** — a change is specified, planned, and validated before code.
- **Research first** — design decisions are informed by research and analysis, not assumption.
- **Documentation as code** — docs are versioned, reviewed, and generated like code.
- **Living documentation** — docs must reflect the shipped reality, never a stale plan.
- **Single source of truth** — information lives once; other files reference, not copy.
- **Incremental delivery** — foundation first; optimize after it is stable.
- **Automation first** — automate what can be automated.
- **Host agnostic** — one core; hosts are thin targets.
- **Maintainability over complexity.**
- **Adopt ideas, not copies.**

---

## Roadmap structure

The roadmap is a set of **capabilities**, each an independent development area that breaks down into: **capability → epic → slice → task → implementation**.

## Capability index

| # | Capability | Status | Priority |
|---|------------|--------|----------|
| 1 | [Package Distribution & Release Management](capability-01-package-distribution.md) | Completed | High |
| 2 | [CLI Runtime & User Experience](capability-02-cli-runtime.md) | Completed — CLI + TUI + command palette | High |
| 3 | [Built-in Skill System](capability-03-builtin-skill-system.md) | Completed — 26 skills + registry + quality gate + evals | High |
| 4 | [End-to-End AI Development Workflow](capability-04-ai-development-workflow.md) | Completed — all 6 deltas implemented (2026-08-11) | High |
| 5 | [Runtime Infrastructure & Local Daemon](capability-05-runtime-infrastructure.md) | Shipped (daemon + store) | Medium |
| 5.5 | [Host Abstraction Layer (HAL)](capability-05-5-host-abstraction-layer.md) | Shipped core (5 adapters) | High |
| 6 | [Documentation & Knowledge System](capability-06-documentation-knowledge-system.md) | Shipped core (Diátaxis + auto-gen) | High |
| 7 | [Engineering Governance & Project OS](capability-07-engineering-governance.md) | Shipped core (ADRs + CI gates) | High |
| 8 | [Platform Engineering & Developer Experience](capability-08-platform-engineering-dx.md) | Shipped core (toolchain) | Medium |
| 9 | [AI Platform Evolution & Long-Term Vision](capability-09-platform-evolution.md) | Vision | Low |

> The authoritative machine-readable status lives in [`roadmap.manifest.yaml`](roadmap.manifest.yaml) — keep it in sync when STATUS.md changes.

## Capability dependency

```text
C1  Package Distribution
 │
 ▼
C2  CLI Runtime & UX
 │
 ▼
C3  Built-in Skill System
 │
 ▼
C4  End-to-End AI Development Workflow
 │
 ▼
C5  Runtime Infrastructure & Local Daemon
 │
 ▼
C5.5 Host Abstraction Layer (HAL)
 │
 ▼
C6  Documentation & Knowledge System
 │
 ▼
C7  Engineering Governance & Project OS
 │
 ▼
C8  Platform Engineering & DX
 │
 ▼
C9  AI Platform Evolution & Vision
```

This is a *conceptual* dependency graph. The final implementation dependency is determined by the specification of each capability.

## How to use this roadmap

- **When shipping a version:** update `releases.md` + `STATUS.md` + `roadmap.manifest.yaml`, add the release to the root `CHANGELOG.md`, run `pnpm release:history`.
- **When direction changes:** update the vision + capability index, and record the *why* as an ADR in `docs/decisions/`.
- **When tempted to add scope:** check `backlog.md` / `releases.md` Deferred table — if it is listed, it is intentional; add new deferrals there rather than dropping them silently.
- **To change a capability doc:** see [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Relationship with other documents

```text
Roadmap (this directory)  →  direction only
        │
        ▼
Capability specification  →  implementation reference
        │
        ▼
Architecture → Planning → Slice → Implementation
        │
        ▼
Checkpoint → Release → Documentation
```

The roadmap is strategic direction. The **specification** is the implementation reference.

## Important notes

The directory structures, workflows, diagrams, module names, and examples in these roadmap docs are **not final designs**. They explain concepts and direction. Before implementation, technical decisions are made through: codebase audit → research → alternative analysis → trade-off evaluation → architecture proposal → specification → review → implementation. Where research shows a better approach than the roadmap's example, follow the research. The roadmap provides **direction**, not constraint.
