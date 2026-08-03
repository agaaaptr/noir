# Capability 8 — Platform Engineering & Developer Experience (DX)

> **Status:** Shipped core — monorepo toolchain + CI + release tooling live; benchmarks/metrics are research

## Overview

The internal platform-engineering layer of Noir itself: a pnpm monorepo with unified lockstep versioning, TypeScript ESM, Biome, Vitest, a CI quality gate, tag-triggered npm release tooling with provenance, and package scaffolding. The DX deliverables that exist (generators, installers, onboarding docs) are listed; performance/metrics tooling is open.

## Shipped today

- **pnpm 10.12.4 monorepo** — 11 `@noir-ai/*` packages, unified lockstep versioning, `engines.node >=22` + `.nvmrc` = `22`. Sources: [`package.json`](../../package.json), [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml), [`.nvmrc`](../../.nvmrc).
- **tsup ESM build per package** (`esm`, `dts`, `clean`, `sourcemap`). Source: `package.json` scripts.
- **TypeScript strict ESM** — `NodeNext`, `ES2022`, `strict`, `noUncheckedIndexedAccess`, declarations. Source: [`tsconfig.base.json`](../../tsconfig.base.json).
- **Biome lint + format** (preset `recommended`). Source: [`biome.json`](../../biome.json).
- **Vitest 3 test suite** with source aliases for all 11 packages. Source: [`vitest.config.ts`](../../vitest.config.ts).
- **CI matrix** — ubuntu + macos on node 22; gate = lint → build → typecheck → test → `docs:validate`. Source: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml).
- **Release pipeline** — tag-triggered, verify-then-publish, `npm publish --provenance` (SLSA via GitHub OIDC), version-string-based channel (beta vs stable). Source: [`.github/workflows/release.yml`](../../.github/workflows/release.yml).
- **Release registry + unified version tooling** — `bump-version.mjs`, `compute-version.mjs`, `release-registry.mjs`, `release-tag.mjs`. Source: [`scripts/`](../../scripts/).
- **Docs automation** — `scripts/docs-generate.mjs` with `generate|validate|registry|index` subcommands. Source: [`scripts/docs-generate.mjs`](../../scripts/docs-generate.mjs).
- **Package scaffolding generator** — `scripts/new-package.mjs` (scaffolds a publish-ready package and wires the vitest source alias). Source: [`scripts/new-package.mjs`](../../scripts/new-package.mjs).
- **Installer** — `scripts/install.sh` (node/npm delegating installer) + Homebrew formula stub at [`packaging/homebrew/noir.rb`](../../packaging/homebrew/noir.rb) (not live until first stable release). Sources: [`scripts/install.sh`](../../scripts/install.sh), [`docs/how-to/installation.md`](../../docs/how-to/installation.md).
- **Onboarding docs** — [`AGENTS.md`](../../AGENTS.md), [`docs/how-to/releasing.md`](../../docs/how-to/releasing.md), [`docs/how-to/packaging.md`](../../docs/how-to/packaging.md), [`docs/how-to/installation.md`](../../docs/how-to/installation.md), [`docs/getting-started.md`](../../docs/getting-started.md).

## Gap / roadmap delta

- **Repository health checker** — no automated scan for duplicates, stale files, or orphan docs beyond `docs:validate`.
- **Benchmark suite + perf regression gate** — no performance measurement today (startup, indexing, context/skill loading).
- **Engineering metrics collection** — no build/test/lint duration, coverage, or tech-debt tracking.
- **Capability/specification/slice generator + roadmap updater** — `new-package.mjs` only scaffolds a package.
- **Engineering command layer** beyond release/validate — no `audit` / `benchmark` / `cleanup` / `repair` / `migrate` commands.
- **DX guideline document + explicit engineering-platform specification.**
- **Automated changelog generation** — `CHANGELOG.md` is hand-maintained today.
- **Dependency-update automation** — no dependabot/renovate.
- **Debugging/tracing/profiling strategy tooling** — only `noir doctor` (`packages/cli/src/commands/doctor.ts`) exists.
- **Hot-reload dev loop** — currently tsup rebuild + `vitest` watch; no single watch/dev command.

## Acceptance criteria

- **MET** — `pnpm install && pnpm build && pnpm test` passes from a clean checkout on node 22 (local + CI matrix).
- **MET** — a version tag push publishes all 11 `@noir-ai/*` packages with `--provenance` and updates the release registry + docs automatically.
- **MET** — `scripts/new-package.mjs <name>` produces a publish-ready package with the vitest alias wired.
- **GAP** — `pnpm health` reports duplicates/stale/orphan artifacts and exits non-zero on findings (extends `docs:validate`).
- **GAP** — a benchmark suite with a perf regression gate runs in CI on `main`/`develop`; regressions fail the build.
- **GAP** — an engineering command layer exposes `audit` / `benchmark` / `cleanup` / `repair` / `migrate` alongside the existing release/validate commands.
- **GAP** — changelog and dependency updates are generated/opened automatically by tooling, not hand-maintained.

## References

- [`package.json`](../../package.json)
- [`pnpm-workspace.yaml`](../../pnpm-workspace.yaml)
- [`tsconfig.base.json`](../../tsconfig.base.json)
- [`biome.json`](../../biome.json)
- [`vitest.config.ts`](../../vitest.config.ts)
- [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
- [`.github/workflows/release.yml`](../../.github/workflows/release.yml)
- [`scripts/`](../../scripts/)
- [`packaging/homebrew/noir.rb`](../../packaging/homebrew/noir.rb)
- [`AGENTS.md`](../../AGENTS.md)
- [`docs/how-to/releasing.md`](../../docs/how-to/releasing.md)
- [`docs/how-to/packaging.md`](../../docs/how-to/packaging.md)
- [`docs/how-to/installation.md`](../../docs/how-to/installation.md)
