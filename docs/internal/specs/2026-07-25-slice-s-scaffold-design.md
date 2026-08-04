# Slice S — Intelligent Project Scaffolding (AI-layer) — design spec

> v1.x capability slice. Companion: `docs/internal/specs/2026-07-25-v1x-capabilities-design.md` §4.5. **Predecessor keystone K (committed)** provides `managedBlock` + `blockWriter` (`writeManagedRegion`/`commentStyleFor`) foundations — reuse, don't reinvent.
> **Status: NOT started.** This spec is the implementation reference; the next session writes the plan + executes.

## Goal
Evolve `noir init` from a thin writer into an **AI-LAYER scaffolder**, and add **`noir create`** (greenfield first-run). Noir owns the AI foundation; code structure is composed from external scaffolders (`pnpm create`/create-t3/Nx), never reinvented.

## Locked decisions (Q5a/e/b/c/d)
- **New `@noir-ai/create` package** (`manifest.ts` + `templates/` + `migrations/` + `writers.ts`).
- **`noir create` command** (bin → `npm create noir-ai`), distinct from `noir init` (attach/re-run/`--upgrade`); both share the engine.
- AI-layer only (no code-structure generation).
- Stack-detect broad (Node/Python/Go/Rust markers) for path-adaptation + ignore.
- Template language: hand-rolled `{{var}}`.
- Monorepo: workspace-root AI layer + per-package `AGENTS.md` opt-in.

## Architecture
- **Three-mode writer** (`@noir-ai/create/writers.ts`, generalizes keystone K's `writeManagedRegion`):
  - `regenerate(file, content)` — pure pointers (`CLAUDE.md`, `AGENTS.md`, `.mcp.json`, emitted skills): always overwritten.
  - `managedBlock(file, block, content)` — co-owned (`NOIR.md` brief, `.gitignore` noir block, `README.md` AI-section): re-emitted idempotently via K's `blockWriter`.
  - `skipIfExists(file, content)` — user-owned seeds (`RULES.md`, `prd.md` seed, `roadmap.md`, ADR skeleton, `config.yml`): written once, never overwritten.
- **Manifest** (`@noir-ai/create/manifest.ts`): declarative artifact table `{ path, mode, host, content | template }` — the single source of truth for what init/create/sync write.
- **Templates** (`@noir-ai/create/templates/`): markdown/yaml/json with `{{var}}`.
- **`.noir/scaffold-version`**: `noir-scaffold=<v>`; read on init/doctor for upgrade decisions.
- **Migrations** (`@noir-ai/create/migrations/<from>-<to>.mjs`): declarative upgrade scripts; `noir init --upgrade` runs them; **conflict=inline** (not interactive) so `--no-input` CI survives.
- **Stack-detect** (read-only, never assumes): `package.json`/workspaces/`turbo.json`/`nx.json`/`Cargo.toml`/`go.mod`/`pyproject.toml` + framework markers; surface in onboarding TUI; user confirms.
- **HYBRID workspace**: `.noir/` canonical store + thin root pointers (CLAUDE.md/AGENTS.md/README/.mcp.json/.gitignore).
- **Composition**: shadcn-model attach-to-existing/fill-gap; for greenfield document `pnpm create … && noir init` order; never wrap.

## CLI surface
- `noir init` — first run + `--upgrade` (existing; refactored to consume the manifest/engine).
- `noir create [dir]` — **new** greenfield first-run (bin in `@noir-ai/create` → `npm create noir-ai`); bootstraps AI layer in a new/empty dir.
- `noir sync` — re-emit regenerate+managedBlock subset (existing; refactored).
- `noir doctor` — report scaffold-version drift (extended).

## Refactor from current state (post-K/R/I/P)
`cli/init.ts` + `cli/sync.ts` currently do ad-hoc writes (regenerate for `.mcp.json`; managedBlock for CLAUDE.md context+rules; skipIfExists for `RULES.md`/`NOIR.md` seed; `syncIgnores` for ignore files). **Unify all under the manifest + three-mode writer in `@noir-ai/create`**; `cli` becomes a thin caller. The existing tests (init/skills-emit/skills) become the regression gate.

## Acceptance
- `noir init` produces the full AI foundation via the manifest (three-mode); idempotent re-run; `--upgrade` runs migrations.
- `noir create <dir>` bootstraps a fresh dir's AI layer (no code generation).
- `.noir/scaffold-version` stamped; `noir doctor` reports drift.
- Stack-detect runs read-only, never assumes.
- 746+ tests green; new tests for three-mode writer + manifest + scaffold-version; K's `blockWriter` reused (no duplication).

## Open questions (next-session clarification)
- **S-OQ1:** `noir create` — strictly AI-layer-only (user runs scaffolder separately), or optionally CHAIN an external scaffolder (`noir create node-app` → `pnpm create vite` + init)? [lean: AI-layer-only now; chaining = future]
- **S-OQ2:** migration conflict resolution — inline markers (recommended, CI-safe) vs interactive prompt?
- **S-OQ3:** scaffold-version start value (`1.0.0`? `0.1.0`?) + bump policy per Noir release.

## Risks
- Three-mode writer complexity (mitigate: K's blockWriter already proves managedBlock; regenerate/skipIfExists are trivial).
- Marker portability per file-type (mitigate: K's `commentStyleFor` + `managedBlock` html/hash).
- Monorepo per-package `AGENTS.md` noise (opt-in default; Hackernoon AGENTS.md-effectiveness caveat).
- init/sync writer divergence (mitigate: extract shared writer early; both consume the manifest).
