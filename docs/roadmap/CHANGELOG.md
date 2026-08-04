# Roadmap Changelog

All changes to the roadmap are recorded here. Each entry should reference the ADR / specification / research that motivated it.

## 2026-08-03

### Added
- `releases.md` — migrated the shipped-status, release history, version targets, and deferred-features content from the former `docs/roadmap/` (grounded to the 1.6.0 reality).
- `backlog.md` — consolidated the v1.x backlog + verified capability gaps.
- `capability-05-5-host-abstraction-layer.md` — C5.5 split out of C5 (matches the index + manifest).
- Capability docs C1–C9 rewritten in the canonical grounded format (Overview → Status → Shipped → Gap → Acceptance → References).

### Changed
- `README.md` — canonical philosophy + lifecycle (single source); capability index grounded.
- `STATUS.md` — status table grounded to shipped reality (was all-Planned).
- `roadmap.manifest.yaml` — status/priority/active synchronized with STATUS.md.
- Capability files deduplicated: philosophy/lifecycle/research boilerplate collapsed into `README.md`/`ROADMAP.md`.

### Removed
- `docs/roadmap/` (old) — superseded by `docs/roadmap/` + `releases.md` + `backlog.md`; external references updated.

### Notes
- Grounding sources: codebase audit of `packages/*`, `scripts/`, `.github/workflows/`, `docs/` (2026-08-03).
- Docs generator updated: `docs/roadmap/*` → `roadmap` category; `docs/CHANGELOG.md` → root CHANGELOG pointer.
