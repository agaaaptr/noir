# Capability 9 — AI Platform Evolution & Long-Term Vision

> **Status:** Vision (north star) — with the shipped platform reconciled as the baseline

## Overview

Noir's long-term strategic direction as an AI development platform. Several "vision" items are already shipped (hybrid retrieval, vector search, host-agnostic core, structured output, MCP); others (multi-agent, autonomous engineering, enterprise) are deliberate non-goals or deferred to v2.0. This doc keeps the vision framing grounded in what the platform actually is today — every future-facing item is either shipped-and-verified, or a named gap with a concrete done-condition.

## Shipped today

- **11 `@noir-ai/*` packages at 1.9.0, 33 builtin `noir-` skills (+ 1 integration), release registry** tracking versions from 1.5.0 through 1.9.0 ([`AGENTS.md`](../../AGENTS.md), [`docs/roadmap/releases.md`](releases.md)).
- **Bounded model layer** — single-shot `complete()`, provider-explicit, null-degradation, no tools/stream by construction (D5) ([`packages/model/src/complete.ts`](../../packages/model/src/complete.ts)).
- **Hybrid retrieval** — BM25 ∪ kNN → RRF, local 384-dim embeddings by default, remote/Ollama embedders opt-in ([`packages/context/src/contextEngine.ts`](../../packages/context/src/contextEngine.ts)).
- **Cross-session memory** — save/recall/search/sessions/forget/consolidate, provider-gated consolidation that refuses cleanly without a provider ([`packages/memory/src/engine.ts`](../../packages/memory/src/engine.ts)).
- **Daemon MCP server** — 17+ tools, stdio + Streamable HTTP transports, single-writer store ([`packages/daemon/src/server.ts`](../../packages/daemon/src/server.ts)).
- **CLI** — commander command tree, home menu, Ink TUI MVP, `noir doctor`, stable exit codes ([`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts)).
- **SDD workflow engine** — FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with observable, escapable gates (D4) + soft PRD recommendation ([`docs/internal/specs/2026-07-23-noir-toolkit-design.md`](../../docs/internal/specs/2026-07-23-noir-toolkit-design.md)).
- **5 host adapters + universal AGENTS.md** — `claude`/`agents-md`/`gemini`/`cursor`/`opencode` via `resolveAdapter(host)` (ADR-0004) ([`docs/decisions/0004-multi-host-adapters.md`](../decisions/0004-multi-host-adapters.md)).
- **Release automation** — auto-prerelease versioning, branch-based dist-tag (stable/beta), SLSA provenance, version registry ([`docs/roadmap/releases.md`](releases.md)).

## Gap / roadmap delta

- **Wire `draftPrd` into a real runtime consumer** — second caller beyond memory consolidation.
- **Fix memory auto-capture CLI/doc mismatch** — template says `noir memory capture`; CLI exposes only recall/save/sessions/forget/consolidate.
- **Technology radar artifact** (adopt/trial/assess/hold) — acceptance criterion claims it must exist; nothing does.
- **Innovation backlog artifact** — items with objective/value/complexity/dependency/research-status/recommendation.
- **New-technology evaluation mechanism + periodic research cadence.**
- **Sunset/deprecation strategy** (evaluate/deprecate/migrate/remove) — only ADR-0002 (no plugin/marketplace) exists as a one-off; no repeatable mechanism ([`docs/roadmap/releases.md`](releases.md)).
- **Semantic knowledge graph** (memory graph / temporal-KG) — genuinely deferred, not scoped.
- **AI Engineering Analytics** — productivity, roadmap progress, spec coverage, doc health, tech-debt, release quality.
- **Autonomous-engineering surfaces beyond PRD drafting** — must respect D5 no-agent-loop and D4 human gates (see [`docs/internal/specs/2026-07-23-noir-toolkit-design.md`](../../docs/internal/specs/2026-07-23-noir-toolkit-design.md)).
- **Enterprise readiness** (SSO/RBAC/audit/policy/compliance/secret-mgmt/org) + OS keychain — v2.0 / non-priority.

Deferred engineering items are tracked per-area in [`docs/roadmap/backlog.md`](backlog.md).

## Acceptance criteria

- **MET** — Long-term vision framing is grounded: every shipped item above resolves to a real path in this repo; no shipped claim without a source.
- **MET** — Hybrid retrieval, vector search, host-agnostic core, structured output, and MCP exist and are exercised (context engine, model layer, host adapters, daemon).
- **MET** — Multi-agent collaboration, autonomous engineering, and enterprise readiness are explicitly recorded as non-goals / v2.0, not as active backlog.
- **DONE** — `draftPrd` has a runtime consumer beyond memory consolidation (new caller wired in `packages/*/src`).
- **DONE** — `noir memory capture` exists in the CLI or the template's documented command matches the CLI surface ([`packages/memory/src/engine.ts`](../../packages/memory/src/engine.ts), [`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts)).
- **DONE** — Technology radar artifact exists with items classified adopt/trial/assess/hold.
- **DONE** — Innovation backlog artifact exists with the required item fields.
- **DONE** — Sunset/deprecation mechanism is documented as a repeatable evaluate/deprecate/migrate/remove process (beyond ADR-0002).

## References

- [`packages/model/src/complete.ts`](../../packages/model/src/complete.ts) — bounded model layer
- [`packages/context/src/contextEngine.ts`](../../packages/context/src/contextEngine.ts) — hybrid retrieval / RRF
- [`packages/memory/src/engine.ts`](../../packages/memory/src/engine.ts) — cross-session memory
- [`packages/daemon/src/server.ts`](../../packages/daemon/src/server.ts) — MCP daemon
- [`packages/cli/src/bin.ts`](../../packages/cli/src/bin.ts) — CLI surface
- [`docs/internal/specs/2026-07-23-noir-toolkit-design.md`](../../docs/internal/specs/2026-07-23-noir-toolkit-design.md) — design blueprint, D4/D5 decisions
- [`docs/roadmap/releases.md`](releases.md) — release registry / version narrative
- [`docs/roadmap/backlog.md`](backlog.md) — deferred engineering items
- [`docs/decisions/0004-multi-host-adapters.md`](../decisions/0004-multi-host-adapters.md) — host adapters ADR
- [`AGENTS.md`](../../AGENTS.md) — repo-level grounding (packages, skills, adapters)
