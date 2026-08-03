# Noir Roadmap Status

Implementation status of every Noir capability. **Updated at every checkpoint** — keep in sync with [`roadmap.manifest.yaml`](roadmap.manifest.yaml).

## Status

| Capability | Progress | Current Phase | Last Update |
|------------|----------|---------------|-------------|
| C1 Package Distribution | 🟩 Completed | Ship | 2026-08-04 |
| C2 CLI Runtime & UX | 🟦 Partial — full CLI + TUI MVP shipped | Ship + Research (richer TUI, daemon detach) | 2026-08-03 |
| C3 Built-in Skill System | 🟦 Partial — 33 skills + compiler shipped | Ship + Research (registry/versioning) | 2026-08-03 |
| C4 AI Development Workflow | 🟩 Shipped core (SDD engine) | Ship | 2026-08-03 |
| C5 Runtime Infrastructure & Daemon | 🟩 Shipped (daemon + store) | Ship | 2026-08-03 |
| C5.5 Host Abstraction Layer | 🟦 Partial — 5 adapters shipped | Ship + Research (negotiation/certification) | 2026-08-03 |
| C6 Documentation & Knowledge System | 🟦 Partial — Diátaxis + auto-gen shipped | Ship + Research (drift detection) | 2026-08-03 |
| C7 Engineering Governance | 🟦 Partial — ADRs + CI gates shipped | Ship + Research (tech-debt registry) | 2026-08-03 |
| C8 Platform Engineering & DX | 🟦 Partial — toolchain shipped | Ship + Research (benchmarks/metrics) | 2026-08-03 |
| C9 AI Platform Evolution | 🟦 Vision | Vision | 2026-08-03 |

## Legend

- ⬜ Planned
- 🟨 Research
- 🟦 Specification / In progress
- 🟪 Planning
- 🟧 Implementation
- 🟩 Completed
- 🟥 Blocked

> **Partial** = the core of the capability is shipped and working; the remaining work is the capability doc's "Gap / roadmap delta" (see `backlog.md` for the consolidated list).

## Current sprint

- **2026-08-03** — C1 native installer + migration + self-update shipped (Tasks 1–11): managed-Node installer (`install.sh` + `install.ps1`), `noir install`/`migrate`, `noir update` + async cached version check, doctor install row, Homebrew formula (real url/sha256), Scoop manifest, installer attestation (SHA256SUMS + Sigstore). ADR-0005 records the managed-Node-not-single-binary decision; winget/Chocolatey deferred.
- **2026-08-03** — Roadmap restructure: capability docs rewritten grounded against the shipped codebase; `releases.md` + `backlog.md` created; roadmap made the project reference.
- **2026-08-03/04** — C1 managed-Node auto-provisioning (P1–P6): `provisionManagedNode()` in `@noir-ai/core` (`packages/core/src/node-provision.ts`) — download + verify (SHA256 checksum, fail-closed) + extract Node 22.23.2 LTS into `~/.noir/runtime/node/`; atomic writes (staging → rename); auto-cleanup old runtime versions. `MANAGED_NODE_VERSION` constant exported from core, shared with `install.sh`/`install.ps1` via `scripts/node-version.env`. `noir install`/`migrate` now calls `provisionManagedNode()` (CLI can bootstrap without a shell script). CI `node-provision-smoke` job validates real Node download. Release registry rebuilt with accurate channel labels + non-null `changelogRef` for every entry. C1 → Completed.

## Active capability

- **C2 — CLI Runtime & UX** (next up: TUI delta — richer widgets, command palette)

## Active slice

- (none active; C1 `c1-native-installer` is complete)

## Next milestone

- Publish the C1 native-installer + managed-Node provisioning work as a beta (separate phase, explicit go-ahead required). Then return to the C2 TUI delta (richer widgets, command palette).

## Current technical debt

- `docs/reference/config.md` + `mcp-tools.md` were stale skeletons — regenerated 2026-08-03.
- `docs/reference/cli-auto.md` duplicate removed 2026-08-03 (single source: `cli.md`; stale ref in `capability-02` also cleared).
- `CHANGELOG.md` unified to root (docs/CHANGELOG.md is now a pointer) — 2026-08-03.
- Stale doc path labels in `AGENTS.md` + ADR-0001 (`docs/superpowers/`/`docs/specs/` → real `docs/internal/{specs,plans}`) — tracked, not yet fixed.
- C1 native-installer work is committed locally on `develop` (not pushed); publish is a separate phase.

## Notes

Status is updated at every implementation checkpoint. When a capability's phase changes, update both this table **and** [`roadmap.manifest.yaml`](roadmap.manifest.yaml).
