# Capability 1 — Package Distribution & Release Management

> **Status:** 🟩 Completed — managed-Node provisioning, native installer, self-update, registry accuracy, package-manager taps all shipped; winget/Chocolatey deferred by decision

## Overview

How Noir is distributed (npm monorepo, native installer, package-manager taps, release channels) and how releases are versioned, published, and recorded. The npm/release-automation core, the native managed-Node installer, the CLI self-update/migrate path, and the Homebrew/Scoop taps are shipped; winget/Chocolatey are deferred by decision (see ADR-0005).

## Shipped today

- Full 11-package `@noir-ai/*` monorepo published to npm at a unified version (lockstep across all 11 packages) with SLSA provenance (`publishConfig.provenance: true` + `npm publish --provenance` in CI) — `packages/cli/package.json`, `.github/workflows/release.yml`.
- Two live dist-tags: `latest` (stable) and `beta` (prerelease). Installable via npm/pnpm/yarn/bun and one-shot via npx/pnpm dlx/yarn dlx/bunx — `docs/how-to/installation.md`.
- Version-string-based release channel detection in CI: tag `vX.Y.Z` → `latest`, `vX.Y.Z-beta.N` → `beta` — `.github/workflows/release.yml`.
- Auto-generated release registry `.noir/releases/releases.json` + `releases.md`, with rebuild/validate/history tooling and a JSON schema (`schemas/release-registry.schema.json`, `scripts/release-registry.mjs`).
- Auto-computed beta numbering (`scripts/compute-version.mjs`, `scripts/release-tag.mjs`) and unified version bumping (`scripts/bump-version.mjs`).
- Idempotent publish: CI pre-checks npm and skips re-publish; auto-creates a GitHub Release per tag — `.github/workflows/release.yml`.
- **Native installer** — managed-Node, not single-binary (research-verified; see ADR-0005):
  - `scripts/install.sh` (POSIX) + `scripts/install.ps1` (Windows PowerShell): provision a pinned Node 22.x runtime under `~/.noir/runtime/`, install `@noir-ai/cli` into an isolated prefix under `~/.noir/cli/`, write a `noir` shim at `~/.noir/bin/noir` (`.cmd` on Windows), record the install in `~/.noir/install.json` (`method: native`). No system Node prerequisite, no `sudo`/admin. Idempotent (re-run = upgrade). `NOIR_CHANNEL`/`NOIR_VERSION` env knobs; proxy pass-through; PATH hint; `noir --version` verify.
  - Windows PowerShell (`install.ps1`) is the primary Windows path — no Git Bash/MSYS2/WSL needed.
  - Trust: installers are published as Release artifacts with a `SHA256SUMS` file + a Sigstore build-time attestation (`actions/attest-build-provenance@v3`); consumers verify with `shasum -a 256` + `gh attestation verify install.sh --repo agaaaptr/noir`.
- **CLI self-update + migration** (`packages/cli/src/commands/{install,update}.ts`, `packages/core/src/install-*.ts`):
  - `noir install` / `noir migrate [spec]` — move an existing install to the native path; preserves all settings (`.noir/` + `~/.noir/` data untouched); `--list` detects every install; `--uninstall-prev` removes the prior method (never auto-uninstalls; prints the suggested command when omitted).
  - `noir update [spec]` / `noir update --check` — self-update via the active install method (native → re-provision; npm/pnpm/yarn/bun/Homebrew/Scoop → reinstall via that manager).
  - **Async startup version check** — non-blocking, cached (`~/.noir/update-cache.json`), 24h interval default; honors `NOIR_DISABLE_UPDATE_CHECK` (background check only) and `NOIR_DISABLE_UPDATES` (hard kill-switch for the whole self-update surface).
  - **Version-assert** — `noir install`/`update` refuses a silent downgrade (per-segment numeric semver comparison); an explicit positional version pin prints a warning.
  - **Doctor install row** (`noir doctor`) — advisory `ok`/`warn` only, never `fail`, never a live network call; reports the detected method, installed version, latest-known version, and a `native recommended` nudge on non-native paths.
- **Managed-Node auto-provisioning** (`packages/core/src/node-provision.ts`, `packages/core/src/layout.ts`, `scripts/node-version.env`):
  - `provisionManagedNode()` — downloads, verifies (SHA256 checksum, fail-closed), and extracts a pinned Node 22.23.2 LTS runtime under `~/.noir/runtime/v<version>/`; atomic writes (staging-dir → rename); auto-cleanup of old runtime versions (keep current only).
  - `MANAGED_NODE_VERSION` exported from `@noir-ai/core`; shared with `install.sh`/`install.ps1` via `scripts/node-version.env`.
  - `noir install`/`migrate` now calls `provisionManagedNode()` — the CLI can bootstrap the managed runtime without a shell script.
  - `downloadAndVerify()` / `extractNode()` / `detectNodeTarget()` / `nodeArchiveUrl()` — the full provisioning pipeline as callable exports.
  - CI smoke test (`.github/workflows/ci.yml` `node-provision-smoke` job) validates a real Node download on each push.
- **Homebrew formula** — real `url`/`sha256`/`version` from the published npm tarball (`packaging/homebrew/noir.rb`, Node-for-Formula-Authors pattern; stable-only; tap README at `packaging/homebrew/README.md`).
- **Scoop manifest** — `packaging/scoop/noir.json` (Windows; depends on `nodejs-lts`; shims `dist/bin.js` as `noir`; stable-only single-channel).

## Gap / roadmap delta

- **winget / Chocolatey** — deferred by decision (see ADR-0005). Windows is covered by `install.ps1` (primary), Scoop, and npm; winget/Chocolatey add breadth but no new capability. Will revisit if Windows user demand surfaces.
- **Per-channel update cache** — `~/.noir/update-cache.json` records a single channel; cross-channel isolation is enforced by `latestVersionFromCache(cache, channel)` (returns null on mismatch), but a `Record<channel, version>` shape was deliberately not adopted to preserve the committed `UpdateCache` interface (see Task 11 report).
- **`migrationNotes` / `breakingChanges` / `securityAdvisory`** — structured release metadata beyond `changelogRef` is not yet captured in the registry. `changelogRef` is populated for every entry.

## Acceptance criteria

1. MET — `@noir-ai/*` monorepo publishes to npm with SLSA provenance, at a unified version, from CI.
2. MET — Stable (`latest`) and prerelease (`beta`) dist-tags exist and are installable across npm/pnpm/yarn/bun and one-shot runners.
3. MET — Release registry is auto-generated and validates against `schemas/release-registry.schema.json`.
4. MET — `noir update`/`migrate` and a configurable, cached, async startup version check are shipped; kill-switches `NOIR_DISABLE_UPDATE_CHECK`/`NOIR_DISABLE_UPDATES` honored; semver downgrade guard prevents silent downgrades.
5. MET — Homebrew formula is published with real url/sha256/version; Scoop manifest ships; winget/Chocolatey are deferred by explicit decision (ADR-0005).
6. MET — Native installer (`install.sh` + `install.ps1`) ships as managed-Node (no system Node, no admin); installers are Release artifacts with `SHA256SUMS` + Sigstore attestation.
7. MET — registry rows carry accurate channel labels and non-null `changelogRef` for each release (resolved 2026-08-03 by P4 registry rebuild).

## References

- `docs/how-to/installation.md`
- `docs/how-to/releasing.md`
- `docs/how-to/packaging.md`
- `docs/decisions/0005-native-installer-managed-node.md`
- `scripts/install.sh`
- `scripts/install.ps1`
- `packages/cli/src/commands/install.ts`
- `packages/cli/src/commands/update.ts`
- `packages/core/src/install-method.ts`
- `packages/core/src/install-detect.ts`
- `packages/core/src/update-check.ts`
- `scripts/release-registry.mjs`
- `scripts/bump-version.mjs`
- `packaging/homebrew/noir.rb`
- `packaging/scoop/noir.json`
- `.noir/releases/releases.json`
- `schemas/release-registry.schema.json`
