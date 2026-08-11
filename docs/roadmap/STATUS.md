# Noir Roadmap Status

Implementation status of every Noir capability. **Updated at every checkpoint** — keep in sync with [`roadmap.manifest.yaml`](roadmap.manifest.yaml).

## Status

| Capability | Progress | Current Phase | Last Update |
|------------|----------|---------------|-------------|
| C1 Package Distribution | 🟩 Completed | Ship | 2026-08-04 |
| C2 CLI Runtime & UX | 🟩 Completed | Ship | 2026-08-07 |
| C3 Built-in Skill System | 🟩 Completed — 26 skills + registry + quality gate + evals | Ship | 2026-08-10 |
| C4 AI Development Workflow | 🟩 Shipped core (SDD engine) + full-lifecycle design spec'd | Spec (impl pending) | 2026-08-11 |
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
- **2026-08-03/04** — C1 managed-Node auto-provisioning (P1–P6): `provisionManagedNode()` in `@noir-ai/core` (`packages/core/src/node-provision.ts`) — download + verify (SHA256 checksum, fail-closed) + extract Node 22.23.2 LTS into `~/.noir/runtime/v<version>/`; atomic writes (staging → rename); auto-cleanup old runtime versions. `MANAGED_NODE_VERSION` constant exported from core, shared with `install.sh`/`install.ps1` via `scripts/node-version.env`. `noir install`/`migrate` now calls `provisionManagedNode()` (CLI can bootstrap without a shell script). CI `node-provision-smoke` job validates real Node download. Release registry rebuilt with accurate channel labels + non-null `changelogRef` for every entry. C1 → Completed.
- **2026-08-04** — **C1 published on npm** as **1.7.0** (`latest`) + **1.7.0-beta.1** (`beta`); `main` + `develop` synced. Then two post-release bugfixes on `develop` (pending next publish): **`noir_clickup_write` MCP tool rename** — the dotted name violated the MCP tool-name charset (`[a-z0-9_-]` only) and broke the whole MCP session with `-32000`; renamed repo-wide + added a charset regression guard (`fix(daemon)` `368b766`). **Piped `install.sh` `curl | bash` fix** — `${BASH_SOURCE[0]}` is empty when piped, so `node-version.env` wasn't found; now fetched from the repo raw URL (`fix(dist)` `23d4f19`). Both gates green (1428 tests). Published as **1.7.1** (`latest` + `1.7.1-beta.1`).
- **2026-08-04** — **1.7.1 published** → **1.7.2** published (`latest` + `1.7.2-beta.1`): dynamic-require crash in `noir init --upgrade` conflict path (`fix(cli)` `2c6fc63`), `.mcp.json` absolute native-shim path — fix `spawn noir ENOENT` from GUI MCP clients (`fix` `2f28f91`), installer-UX (PATH-shadow detection `5964a38` + auto-add shell profile `b4e6bb9`). Gates green (1428 tests).
- **2026-08-04/05** — **1.7.3 published** → **1.7.4 published** (`latest` + `1.7.4-beta.1`): shim exec-bit defense-in-depth (`atomicWriteFile` mode preservation + `ensureShimExecutable` self-heal, `fix(core,cli)` `c458770`). Closes the chicken-and-egg "noir update → permission denied" bug permanently. Gates green (1439 tests). All four post-1.7.0 hotfix releases complete.
- **2026-08-05** — **C2 completed** (ADR-0006): the C2 TUI delta + all four acceptance-condition gaps shipped in one session via a 10-agent implementation Workflow + an 11-agent final-verification Workflow (find → adversarial verify, which caught a dead-code BLOCKER in recent-commands persistence and fixed it). **TUI delta:** `Ctrl+K` command palette (data-driven registry derived from the commander tree + hand-rolled fuzzy matcher behind a `FuzzyMatcher` swap seam), input history + recall, persistent recent commands (`~/.noir/<projectId>/tui-history.json`, `NOIR_DISABLE_TUI_HISTORY` opt-out), in-TUI destructive confirmation, searchable output pane (`Ctrl+F`, `n`/`N`). **Gap closure:** `daemon start --detach` real backgrounding (detached child + `mode:'detached'` record + bounded `/health` probe), `context index --force` → full reindex, `--dry-run`/`--preview` on `init`/`create`/`sync`, in-process read-only fallback for read commands when the daemon is down (writes stay daemon-gated). Repo hygiene: dangling doc refs in `bin.ts` removed. **C2 → Completed.** Gates green (1525 tests). Published as **1.8.0** (`latest` + `1.8.0-beta.1`).
- **2026-08-06** — **Home consolidation** (C2 UX delta): grouped home menu (`noir` bare) rebuilt as a two-level section picker + action list backed by a shared React-free curated-section module (`sections.ts`, 5 sections, per-option hints, destructive-confirm, back/next/prev navigation). New `noir palette` command (Ink fuzzy palette palette-first). TUI home Mode (`h` key in dashboard, curated quick-action consuming the same `sections.ts`). Bidirectional menu↔TUI bridge. `HomeDeps.commands` injected from `buildPaletteCommands(createProgram())` at module scope — single-source palette registry for both the menu and dashboard (structurally prevents the blank-Ctrl+K class of discoverability bug). Enhanced `?` cheatsheet. Gates green (1539 tests, +14). Docs sync across 12 user-facing files. Published as **1.9.0**.
- **2026-08-07** — **Home menu crash fix (1.9.1).** Bare `noir` home menu crashed on Enter (`Cannot read properties of undefined (reading 'label')`), arrow dead, Esc dead at the section picker. Root cause: Level 1 used `@clack/prompts` `selectKey` (select-by-typed-letter, no arrow/enter/esc, `_track=false` → `value=undefined` → Enter crash). Fix: upgraded `@clack/prompts` `^0.7.0 → ^1.7.0` (core 1.4.3; Esc→cancel native, empty-options handling, ESM-only), switched both menu levels to `select`. One API break (`validate` `string→string|undefined` in `memory.ts`). Gates green (1539 tests, 0 regression). Published as **1.9.1**.
- **2026-08-07/08** — **TUI visual redesign (1.9.2).** Every TUI surface (dashboard, home menu, palette, search, confirm, help) redrawn with `╭─╮│╰╯` rounded borders + dim dividers; command input / palette query / confirm prompt each get a bordered field; output pane truncates to `contentWidth()` (terminal − border − padding) with `wrap="truncate-end"` so the `noir status` table no longer overflows. New `contentWidth()` + `divider()` helpers centralize the width budget. Presentational only (no logic/keybinding change). Gates green (1539 tests, 0 regression). Published as **1.9.2**.
- **2026-08-11** — **C4 design completion (spec suite).** Full lifecycle analysis + research: a 4-agent codebase audit verified the capability doc against shipped code (the engine is real; the dominant pattern is *wiring gaps* — `resumeTask`, `taskClass`/soft PRD gate, quick-mode `runQuick`, `setBlocked`/`abandon`, and the `prd.mandatoryFor` config bridge all exist in the engine but are unreachable from the CLI/MCP), and a 7-agent web research sweep (≥3 sources each) covered research-phase design, spec-driven development, FSM orchestration, project detection, validation gates + recovery, resume UX, and capability→slice decomposition. Produced **6 design specs** (`docs/internal/specs/2026-08-11-c4-*.md`) closing every C4 delta: surface wiring (#9, most material), verify-gate automation + recovery (#6/#7), research soft-grounding + clarify (#1/#2), project discovery (#3), capability→slice decomposition + `rollback_plan` (#4), and release phase/tool (#5). Doc accuracy drifts fixed in `capability-04` + `explanation/sdd-workflow.md`. **C4 → Shipped core + full-lifecycle design spec'd** (implementation pending, spec-first).

## Active capability

- C4 (End-to-End AI Development Workflow) — design complete (2026-08-11); implementation of the spec suite is next

## Active slice

- `c4-surface-wiring` (first implementation slice: resume + taskClass/PRD gate + quick mode + blocked/abandon + config bridge — `docs/internal/specs/2026-08-11-c4-surface-wiring-design.md`)

- **2026-08-10** — **C3 completed:** skill pack curated 34→26 via 5 merges + gerund renames; all 26 builtins + 1 integration become full playbooks (zero stubs, every skill WHAT+WHEN-described, with follow-up guidance and host-tool maximization). Runtime-derived skill registry queryable via `noir skills registry --json`. Structural quality gate (`validateSkill` + `lintSkill` + `noir skills lint`) checks metadata, required sections, line budget, one-level refs, WHAT+WHEN descriptions. Offline evals harness (`evals/evals.json` + vitest runner) with 2 shipped example evals. ClickUp integration enhanced with STEP-0 auth gate, 12 API pitfalls with corrective patterns, verb dispatch grammar, and attachment handling. Full gate green (1561 tests, lint, build, typecheck, docs:validate).

## Next milestone

- **Implement the C4 spec suite** (spec-first): `c4-surface-wiring` first (activates shipped-but-unreachable engine features — zero FSM change), then verify-gate automation + recovery, research soft-grounding, project discovery, decomposition, and release phase — each as its own slice with a full gate. The **v2 orchestrator TUI** (Archetype B — driving the host CLI as a subprocess, streaming output, token/cost bar) remains tracked for v2 (ADR-0006).

## Current technical debt

- `docs/reference/config.md` + `mcp-tools.md` were stale skeletons — regenerated 2026-08-03.
- `docs/reference/cli-auto.md` duplicate removed 2026-08-03 (single source: `cli.md`; stale ref in `capability-02` also cleared).
- `CHANGELOG.md` unified to root (docs/CHANGELOG.md is now a pointer) — 2026-08-03.
- Stale doc path labels in `AGENTS.md` + ADR-0001 (`docs/internal/`/`docs/internal/specs/` → real `docs/internal/{specs,plans}`) — tracked, not yet fixed.
- **Windows native-install bugs (deferred from the 1.7.3 audit):** win32 managed-Node `npmBin` computes `npm.exe` (Node ships `npm.cmd`); extraction shells out to `unzip` (absent on stock Windows); `install.ps1` lacks the auto-PATH + shadow-detection parity with `install.sh`; Scoop manifest `bin` points at a `.js` with no `node` invocation. All pre-existing, not regressions; need a Windows VM to verify (CI has no Windows smoke — better-sqlite3@13 is source-only). Tracked below.

## Notes

Status is updated at every implementation checkpoint. When a capability's phase changes, update both this table **and** [`roadmap.manifest.yaml`](roadmap.manifest.yaml).
