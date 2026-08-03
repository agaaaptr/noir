# Releases & Version Targets

> **Living record.** Where Noir actually is today, how it got here, and where it is going version-by-version. The authoritative, machine-readable source is the **release registry** (`.noir/releases/releases.json` + `releases.md`), regenerated on every publish by `scripts/release-registry.mjs` and maintained with `pnpm release:history|rebuild|validate`.

- **Origin / detailed rationale:** `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (the full design blueprint + decision log).
- **Decisions of record:** `docs/decisions/` (ADR series — `0001`…`0004`).
- **Per-release narrative:** [`CHANGELOG.md`](../CHANGELOG.md) (root — single source of truth).

---

## Current status

> **As of 2026-08-03. `1.6.0` is `latest` on npm; `1.6.0-beta.1` is `beta`.** Source version is `1.6.0` across all 11 `@noir-ai/*` packages. (Registry: `currentBaseVersion 1.6.0`, `latestStable 1.6.0`, `latestBeta 1.6.0-beta.1`.)

**The platform today (shipped & working):**
- **11 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`, unified versioning, npm with SLSA provenance, dist-tags `latest` + `beta`.
- **33 builtin `noir-` skills** + **1 integration** (`noir-clickup`) — a copy+validate compiler with WHEN-led descriptions, emitted idempotently via `noir init`/`sync` (no plugin, no marketplace — see ADR-0002).
- **SDD workflow engine** — FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with observable, escapable gates, Full/Quick modes, cross-session resume, `.noir/` artifacts, `workflow_*` MCP tools.
- **Hybrid context retrieval** — BM25 ∪ kNN → RRF, local 384-dim embeddings by default (zero API key), remote/Ollama embedders opt-in.
- **Cross-session memory** — save/recall/search/sessions/forget/consolidate, hybrid retrieval reuse, provider-gated consolidation that refuses cleanly without a provider.
- **Bounded model layer** — single-shot `complete()`, 3 adapters, provider-explicit, agent loops impossible by construction.
- **Local daemon** — single-writer store, stdio + Streamable HTTP transports, read-only FS fallback, 17+ MCP tools.
- **5 host adapters** — `claude`/`agents-md`/`gemini`/`cursor`/`opencode` via `resolveAdapter(host)` + universal `AGENTS.md` emitter (ADR-0004).
- **CLI** — commander command tree, `@clack` home menu, Ink `noir tui` MVP, `noir doctor`, stable exit codes, `data → stdout / diagnostics → stderr`.
- **Release automation** — branch-based beta/stable dist-tag, auto-prerelease versioning, version registry, smart release tooling.

> The per-slice shipped record below is the historical narrative. Do not trust in-file test counts — always cross-check `.noir/releases/` and `CHANGELOG.md` for the current number.

---

## Release sequence

All 15 published releases are in the registry; the milestone history is:

- **v1.0.0-beta.1 PUBLISHED on npm** (2026-07-25) — all 10 `@noir-ai/*` packages, dist-tag `beta` + SLSA provenance, consumable via `npx @noir-ai/cli@beta init`. Release setup DONE: scoped `@noir-ai/*`, unified versioning, branch-based beta/stable channel (`release.yml` derives the dist-tag from which branch holds the tag). End-to-end dogfood passed 14/14; all MVP v1.0 acceptance criteria met.
- **v1.1.0-beta.1** — first published the K/R/I/P/S/X v1.x capability work + v1.x debt batch (see ADR-0003).
- **v1.2.0-beta.1** — multi-host (S10) + SDK/doctor remainder (S11): `resolveAdapter(host)` registry, 4 new adapters, universal `AGENTS.md`, `docs/reference/packages.md`, `noir doctor` `publish` check.
- **v1.3.0-beta.1 → v1.3.0-beta.6** — scaffold/TUI discovery (SP-A…H) + real-project validation across hosts. The **scaffold idempotency + universal conflict contract** landed across this series.
- **v1.3.0-beta.7 / v1.3.0-beta.8 / v1.4.0 — pushed but CI FAILED, NEVER PUBLISHED** — a `useColor()` leak: under `CI=true` table headers got ANSI-wrapped and the responsive-table width test measured ANSI bytes as overflow. The work landed in 1.4.0-beta.1 instead.
- **v1.4.0-beta.1 PUBLISHED on npm** (2026-07-27) — the runtime-polish work (install deprecation fixes, output design-system, idempotent scaffold, universal conflict contract, write-path dedup, TUI runtime policy, host handoff, Ink `noir tui` MVP, CI color fix).
- **v1.4.0-beta.2** — release automation: auto-prerelease versioning, version registry, smart release tooling.
- **v1.5.0 — FIRST STABLE PUBLISHED on npm (dist-tag `latest`)** (2026-07-28) — `npm i @noir-ai/cli` now resolves to `1.5.0`. First publication of the `latest` channel from `main`.
- **v1.6.0 — current stable** — released alongside `v1.6.0-beta.1` (beta channel).

---

## Version targets

### v0.x — Foundation & Walking Skeleton  *(shipped)*
**Slices S0–S2.** Monorepo, branding, `.noir/` store, SQLite/FTS5 stores, auto-managed daemon + Noir MCP server (stdio + HTTP).
- **Milestone:** a host CLI connects to Noir over MCP and a tool round-trips. — **MET.**

### v1.0 — Sharp Solo Experience  *(shipped)*
**Slices S3–S9.** Claude Code adapter + scaffolder, SDD workflow engine, builtin skills + compiler, context management, memory management, bounded model layer (optional), polished-but-minimal TUI home screen.
- **Target user:** a solo power-user doing idea → spec → plan → implementation inside **Claude Code**, with persistent cross-session memory.
- **Host scope:** **Claude Code only** (behind an abstract `HostAdapter` so generalization is later mechanical, not architectural). — **MET.**

### v1.x — Cross-CLI & Distribution  *(shipped)*
**Slices S10–S11.** Additional host adapters (OpenCode, Gemini, Agy, Qwen) with per-host emulation; npm publish (`@noir-ai/*`); `noir doctor`; framework docs; SDK surface ("usable as a framework").
- **Milestone:** true cross-CLI + installable product. — **MET** (5 adapters shipped; `qwen`/`agy` deferred — universal `AGENTS.md` covers them).

### v2.0 — Ecosystem  *(long-term, not started)*
- Cloud sync for memory (opt-in).
- Team / multi-user features: shared specs, plans, and memory across a team.
- First-class Noir-native skill registry/distribution.
- Full theming + plugin SDK.
- Programmatic headless driving of host CLIs (multi-step orchestration from the TUI).
- Possibly a hosted/managed offering.

---

## Deferred features (explicit — not abandoned)

These are intentionally out of v1 to keep scope sharp. Each has a target version so it is never silently lost:

| Feature | Target | Why deferred |
|---|---|---|
| Hosts beyond the 5 shipped (`qwen`/`agy`, etc.) | v1.x | Universal `AGENTS.md` covers them; native adapters land later. |
| Memory cloud sync | v2.0 | v1 is solo/local; sync adds auth + infra. |
| Team / multi-user | v2.0 | Requires shared stores, identity, permissions. |
| First-class Noir-native skill registry/distribution | v2.0 | v1 ships its native builtins via `noir init`/`sync` with no install step. |
| Programmatic host-driving (`claude -p`, etc.) | v2.0 | v1 hands tasks off; full automation is later. |
| Full theming + plugin SDK | v1.x / v2.0 | Polish/en extensibility after core is solid. |

---

## How to use this file

- **When shipping a version:** add the release to `CHANGELOG.md` (root) and run `pnpm release:history` to update the registry; advance the "Current status" block and version targets here.
- **When direction changes:** update the vision + version targets, and record the *why* as an ADR in `docs/decisions/`.
- **When tempted to add scope:** check the Deferred table — if it is listed, it is intentional; add new deferrals here rather than dropping them silently.
