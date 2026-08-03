# Capability 1 — Package Distribution & Release Management

> **Status:** Partial — core shipped, distribution breadth + self-update are research

## Overview

How Noir is distributed (npm monorepo, installers, release channels) and how releases are versioned, published, and recorded. The npm/release-automation core is shipped; Scoop/Winget/native-binary/self-update are open.

## Shipped today

- Full 11-package `@noir-ai/*` monorepo published to npm at a unified version (1.6.0) with SLSA provenance (`publishConfig.provenance: true` + `npm publish --provenance` in CI) — `packages/cli/package.json`, `.github/workflows/release.yml`.
- Two live dist-tags: `latest` = 1.6.0 (stable) and `beta` = 1.6.0-beta.1. Installable via npm/pnpm/yarn/bun and one-shot via npx/pnpm dlx/yarn dlx/bunx — `docs/how-to/installation.md`.
- Version-string-based release channel detection in CI: tag `vX.Y.Z` → `latest`, `vX.Y.Z-beta.N` → `beta` — `.github/workflows/release.yml`.
- Auto-generated release registry `.noir/releases/releases.json` + `releases.md`, with rebuild/validate/history tooling and a JSON schema (`schemas/release-registry.schema.json`, `scripts/release-registry.mjs`).
- Auto-computed beta numbering (`scripts/compute-version.mjs`, `scripts/release-tag.mjs`) and unified version bumping (`scripts/bump-version.mjs`).
- Idempotent publish: CI pre-checks npm and skips re-publish; auto-creates a GitHub Release per tag — `.github/workflows/release.yml`.
- `scripts/install.sh` native installer (curl|sh) supporting `NOIR_CHANNEL`/`NOIR_VERSION`, proxy pass-through, sudo policy, PATH hint, and version verify.
- Homebrew formula template `packaging/homebrew/noir.rb` (Node-for-Formula-Authors) plus tap README — **NOT yet published/usable**.

## Gap / roadmap delta

- CLI self-update / version management: no `noir update`/`upgrade`, no startup version check (asynchronous, cached, configurable).
- Complete and publish the Homebrew formula (placeholder `url`/`sha256`/`version` today).
- Scoop / Winget / Chocolatey manifests — none exist.
- Native/binary installer path: `install.sh` delegates to `npm install -g`; bootstrap/rollback/uninstall/repair/self-update not implemented.
- Migration-recommendation messaging in the CLI.
- Richer release metadata: `changelogRef` is `null` on every registry entry; `migrationNotes`/`breakingChanges`/`securityAdvisory` not captured.
- Surface dist-tag `latest`/`beta` detection to the CLI at runtime (release-only today).
- Reconcile registry channel mislabels (1.4.0/1.5.0 rows say `beta` despite stable publishes).

## Acceptance criteria

1. MET — `@noir-ai/*` monorepo publishes to npm with SLSA provenance, at a unified version, from CI.
2. MET — Stable (`latest`) and prerelease (`beta`) dist-tags exist and are installable across npm/pnpm/yarn/bun and one-shot runners.
3. MET — Release registry is auto-generated and validates against `schemas/release-registry.schema.json`.
4. DONE-when — `noir update`/`upgrade` and a configurable, cached, async startup version check are shipped.
5. DONE-when — Homebrew formula is published and installable (real url/sha256/version); Scoop/Winget/Chocolatey manifests or an explicit decision to omit them are recorded.
6. DONE-when — registry rows carry accurate channel labels and non-null `changelogRef` for each release.

## References

- `docs/how-to/installation.md`
- `docs/how-to/releasing.md`
- `docs/how-to/packaging.md`
- `scripts/install.sh`
- `scripts/release-registry.mjs`
- `scripts/bump-version.mjs`
- `packaging/homebrew/noir.rb`
- `.noir/releases/releases.json`
- `schemas/release-registry.schema.json`
