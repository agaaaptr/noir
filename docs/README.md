# Documentation

The Noir toolkit's architecture, the decisions behind it, the design blueprint, the SDD spec/plan history, the living forward plan, and the changelog.

> **What Noir is:** a host-agnostic, spec-driven-workflow + native-context + cross-session-memory layer for agentic CLIs (bring your own agent). Design blueprint: [`specs/2026-07-23-noir-toolkit-design.md`](specs/2026-07-23-noir-toolkit-design.md). Living forward plan: [`roadmap.md`](roadmap.md).

## Structure

| Path | Purpose |
|---|---|
| [`installation.md`](installation.md) | The install reference: native installer (`curl \| sh`), npm/pnpm/yarn/bun, `npx`, Homebrew, beta vs stable channels, requirements, troubleshooting. Start here for *installing* Noir. |
| [`getting-started.md`](getting-started.md) | First-use walkthrough: `noir init`, transports, your first session, switching full/quick. Start here for *using* Noir. |
| [`usage.md`](usage.md) | The reference: transports, SDD modes, the full command tree, the config schema, the `.noir/` + `~/.noir/` layout, privacy rules. |
| [`releasing.md`](releasing.md) | The release runbook: unified versioning, npm auth (automation token + provenance), beta-on-develop / stable-on-main channels, irreversibility rules. |
| [`packaging.md`](packaging.md) | How to add a new `@noir-ai/*` package (`scripts/new-package.mjs`), what's automatic vs manual, when to add vs extend. |
| [`architecture/`](architecture/) | How the 11-package toolkit fits together and how a host connects. |
| [`decisions/`](decisions/) | Architecture Decision Records (ADRs) — *why* a choice was made. |
| [`specs/`](specs/) | The Noir design blueprint (`2026-07-23-noir-toolkit-design.md`). Per-slice design specs live under `superpowers/specs/`. |
| [`superpowers/specs/`](superpowers/specs/) | Per-slice SDD design history (the brainstorm → spec record for each slice). |
| [`superpowers/plans/`](superpowers/plans/) | Per-slice implementation + acceptance plans (the SDD plan history). **Active plans live here** — there is no separate `docs/plans/`. |
| [`roadmap.md`](roadmap.md) | The living forward plan: current status, v1.x backlog, version targets. |
| [`CHANGELOG.md`](CHANGELOG.md) | Notable changes, newest first. |

## Conventions

- Per-slice design specs → `superpowers/specs/YYYY-MM-DD-sN-<topic>-design.md`; implementation plans → `superpowers/plans/YYYY-MM-DD-sN-<topic>.md` (dated). See [ADR-0001](decisions/0001-doc-layout-and-spec-plan-paths.md) and [`../AGENTS.md`](../AGENTS.md).
- **ADRs** are numbered `NNNN-<slug>.md` and append-only — supersede, don't rewrite.
- Cross-link liberally: a spec should link to its plan and any related ADR.
