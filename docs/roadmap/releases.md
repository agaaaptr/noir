# Releases & Version Targets

> **Living record.** Where Noir actually is today, how it got here, and where it is going version-by-version. The authoritative, machine-readable source is the **release registry** (`.noir/releases/releases.json` + `releases.md`), regenerated on every publish by `scripts/release-registry.mjs` and maintained with `pnpm release:history|rebuild|validate`.

- **Origin / detailed rationale:** `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (the full design blueprint + decision log).
- **Decisions of record:** `docs/decisions/` (ADR series — `0001`…`0008`).
- **Per-release narrative:** [`CHANGELOG.md`](../CHANGELOG.md) (root — single source of truth).

---

## Current status

> **As of 2026-08-14. `1.11.0` is `latest` on npm** (published 2026-08-14, alongside `1.11.0-beta.1` on `beta`). **v2 orchestrator TUI** shipped — single-surface palette consolidation (home/help/search → one corpus-aware palette) + `noir run` headless host-driving (`--host`/`--command` profile selection, stream-json, token/cost reducer with max-per-message.id dedup, transcript persistence) + home-menu update-available notice (ADR-0008). Next milestone: (TBD) — remaining v2.0 ecosystem (memory cloud sync, team, skill registry, theming).

**The platform today (shipped & working):**
- **11 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory,create}`, unified versioning, npm with SLSA provenance, dist-tags `latest` + `beta`.
- **Native installer** — managed-Node (not single-binary; ADR-0005): `install.sh` (POSIX) + `install.ps1` (Windows PowerShell) provision a pinned Node 22.x runtime under `~/.noir/`, install into an isolated prefix, write a `noir` shim, record `~/.noir/install.json`. No system Node, no `sudo`/admin. Release artifacts carry `SHA256SUMS` + a Sigstore build-time attestation (`gh attestation verify`).
- **CLI self-update + migration** — `noir install`/`migrate` (move an existing install to native, settings preserved, `--uninstall-prev` explicit, never auto-uninstalls); `noir update` (reinstall via the active method); async cached startup version check (24h default) with `NOIR_DISABLE_UPDATE_CHECK` / `NOIR_DISABLE_UPDATES` kill-switches; semver downgrade guard; `noir doctor` install row (advisory, no network).
- **Homebrew formula + Scoop manifest** — real `url`/`sha256`/`version` from the published npm tarball; stable-only (single-channel taps). winget/Chocolatey deferred (ADR-0005).
- **26 builtin `noir-` skills** + **1 integration** (`noir-clickup`) — a copy+validate compiler with a structural quality gate and WHAT+WHEN descriptions, emitted idempotently via `noir init`/`sync` (no plugin, no marketplace — see ADR-0002).
- **SDD workflow engine** — FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with observable, escapable gates (spec/plan/verify), Full/Quick modes, cross-session resume (`noir task resume`), evidence-backed verify gate (HARD/SOFT tiering), soft PRD gate (taskClass-keyed, `noir task new --class`), research grounding sub-step, `noir task verify` (run config checks + submit evidence), `noir task block|abandon`, `noir task decompose` (capability→slice), `.noir/` artifacts, `workflow_*` MCP tools (status/start/advance/resume/block/abandon/research-record), and `noir release` guided orchestrator.
- **Hybrid context retrieval** — BM25 ∪ kNN → RRF, local 384-dim embeddings by default (zero API key), remote/Ollama embedders opt-in.
- **Cross-session memory** — save/recall/search/sessions/forget/consolidate, hybrid retrieval reuse, provider-gated consolidation that refuses cleanly without a provider.
- **Bounded model layer** — single-shot `complete()`, 3 adapters, provider-explicit, agent loops impossible by construction.
- **Local daemon** — single-writer store, stdio + Streamable HTTP transports, read-only FS fallback, 17+ MCP tools.
- **5 host adapters** — `claude`/`agents-md`/`gemini`/`cursor`/`opencode` via `resolveAdapter(host)` + universal `AGENTS.md` emitter (ADR-0004).
- **CLI** — commander command tree, `@clack` home menu, Ink `noir tui` (v2 single-surface palette — `commands`/`output`/`help` corpora; home/help/search merged), `noir run <prompt>` (v2 headless host-driving), `noir doctor` (incl. install row), `noir install`/`migrate`/`update`, `daemon start --detach` (real backgrounding), `context index --force`, `init`/`create`/`sync --dry-run`/`--preview`, in-process read fallback, stable exit codes, `data → stdout / diagnostics → stderr`.
- **Release automation** — branch-based beta/stable dist-tag, auto-prerelease versioning, version registry, smart release tooling, installer artifacts + checksums + Sigstore attestation.

> The per-slice shipped record below is the historical narrative. Do not trust in-file test counts — always cross-check `.noir/releases/` and `CHANGELOG.md` for the current number.

---

## Release sequence

All published releases are in the registry; the milestone history is:

- **v1.0.0-beta.1 PUBLISHED on npm** (2026-07-25) — all 10 `@noir-ai/*` packages, dist-tag `beta` + SLSA provenance, consumable via `npx @noir-ai/cli@beta init`. Release setup DONE: scoped `@noir-ai/*`, unified versioning, branch-based beta/stable channel (`release.yml` derives the dist-tag from which branch holds the tag). End-to-end dogfood passed 14/14; all MVP v1.0 acceptance criteria met.
- **v1.1.0-beta.1** — first published the K/R/I/P/S/X v1.x capability work + v1.x debt batch (see ADR-0003).
- **v1.2.0-beta.1** — multi-host (S10) + SDK/doctor remainder (S11): `resolveAdapter(host)` registry, 4 new adapters, universal `AGENTS.md`, `docs/reference/packages.md`, `noir doctor` `publish` check.
- **v1.3.0-beta.1 → v1.3.0-beta.6** — scaffold/TUI discovery (SP-A…H) + real-project validation across hosts. The **scaffold idempotency + universal conflict contract** landed across this series.
- **v1.3.0-beta.7 / v1.3.0-beta.8 / v1.4.0 — pushed but CI FAILED, NEVER PUBLISHED** — a `useColor()` leak: under `CI=true` table headers got ANSI-wrapped and the responsive-table width test measured ANSI bytes as overflow. The work landed in 1.4.0-beta.1 instead.
- **v1.4.0-beta.1 PUBLISHED on npm** (2026-07-27) — the runtime-polish work (install deprecation fixes, output design-system, idempotent scaffold, universal conflict contract, write-path dedup, TUI runtime policy, host handoff, Ink `noir tui` MVP, CI color fix).
- **v1.4.0-beta.2** — release automation: auto-prerelease versioning, version registry, smart release tooling.
- **v1.5.0 — FIRST STABLE PUBLISHED on npm (dist-tag `latest`)** (2026-07-28) — `npm i @noir-ai/cli` now resolves to `1.5.0`. First publication of the `latest` channel from `main`.
- **v1.6.0 — released alongside `v1.6.0-beta.1` (beta channel).**
- **v1.7.0** (published 2026-08-04, dist-tag `latest`), alongside **v1.7.0-beta.1** (`beta`). C1 native installer + migration + self-update: managed-Node installer (`install.sh` + `install.ps1`), `noir install`/`migrate`, `noir update` + async cached version check, doctor install row, real Homebrew formula, Scoop manifest, installer attestation (`SHA256SUMS` + Sigstore). Decision record: ADR-0005 (managed-Node, not single-binary; Windows = PowerShell + Scoop; winget/Chocolatey deferred).
- **v1.7.1 (2026-08-04)** — post-1.7.0 bugfixes: `noir_clickup_write` MCP tool rename (dotted name broke the MCP session; `fix(daemon)` `368b766`) + piped `install.sh` `curl | bash` fix (`fix(dist)` `23d4f19`).
- **v1.7.2** (published 2026-08-04, dist-tag `latest`), alongside **v1.7.2-beta.1** (`beta`). Post-1.7.1 bugfixes: dynamic-require crash in `noir init --upgrade` conflict path (`fix(cli)` `2c6fc63`), `.mcp.json` absolute native-shim path (fix `spawn noir ENOENT` from GUI MCP clients, `fix` `2f28f91`), and two installer-UX improvements (`fix(dist)` `5964a38` PATH-shadow detection + `b4e6bb9` auto-add shell profile).
- **v1.7.3** (published 2026-08-05, dist-tag `latest`), alongside **v1.7.3-beta.1** (`beta`). Four post-1.7.2 fixes: the bundling `require()` class fix (`crypto`/`fs` latent crashes), native-install `chmod +x` shim + spinner UX, opencode `opts.command` threading, and store `busy_timeout`. Table-driven cross-adapter parity test (+11 tests → 1439 total).
- **v1.7.4** (published 2026-08-05, dist-tag `latest`), alongside **v1.7.4-beta.1** (`beta`). One critical fix: shim exec-bit defense-in-depth (atomicWriteFile mode preservation + ensureShimExecutable self-heal). Closes the chicken-and-egg "noir update → permission denied" bug permanently.
- **v1.8.0** (published 2026-08-05, dist-tag `latest`), alongside **v1.8.0-beta.1** (`beta`). Capability 2 completed (ADR-0006): the **C2 TUI delta** (`Ctrl+K` command palette derived from the commander tree + hand-rolled fuzzy matcher behind a swap seam, searchable output `Ctrl+F`, persistent recent commands, in-TUI destructive confirmation, input-history recall) and **all four acceptance-condition gaps** (`daemon start --detach` real backgrounding, `context index --force` full reindex, `init`/`create`/`sync` `--dry-run`/`--preview`, in-process read-only fallback for read commands). Repo-hygiene cleanup. Gates green (1525 tests). C2 → Completed.
- **v1.9.0** (published 2026-08-06, dist-tag `latest`), alongside **v1.9.0-beta.1** (`beta`). Home consolidation — grouped home menu (two-level `selectKey` + `select` with 5 sections, per-option hints, destructive-confirm, back/next/prev navigation) backed by a shared React-free curated-section module (`sections.ts`, no-drift — every action references a palette-registry id). New `noir palette` command (Ink fuzzy palette palette-first, `requireInteractive`-gated, lazy-imported). TUI home Mode (`h` key in dashboard, curated quick-action consuming the same `sections.ts`). Bidirectional menu↔TUI bridge. `HomeDeps.commands` injected from `buildPaletteCommands(createProgram())` at module scope (single-source palette registry for both the menu and dashboard). Enhanced `?` cheatsheet listing home actions. Gates green (1539 tests, +14). 11 files, +1291/-137.
- **v1.9.1 (2026-08-07)** — **home-menu crash fix.** Bare `noir`'s Level-1 section picker used `@clack/prompts` `selectKey`, which in 0.7.0 is a *select-by-typed-letter* prompt: no arrow/enter/esc handling, and Enter leaves `value` `undefined` → render submit dereferences `options.find(o => o.value === undefined)` → **`Cannot read properties of undefined (reading 'label')` crash**. Both menu levels now use `select` (arrow + Enter + Esc/Ctrl+C work), and `@clack/prompts` is upgraded `^0.7.0 → ^1.7.0` (core 1.4.3) so Esc→cancel and empty-option handling are native. Fixes the 1.9.0 arrow/Esc-dead + Enter-crash home menu. Gates green (1539 tests).
- **v1.9.2 (2026-08-07)** — **TUI visual redesign.** Every TUI surface now renders major regions inside `╭─╮│╰╯` rounded borders with dim dividers; command input / palette query / confirm prompt each get a bordered field; output pane truncates to `contentWidth()` with `wrap="truncate-end"`. New `contentWidth()` + `divider()` helpers. Presentational only. Gates green (1539 tests).
- **v1.9.3 (2026-08-08)** — **TUI polish.** New shared `<Panel>` component eliminates duplicated border props across 5 surfaces. Block cursor (`▌`) on empty command input. Fixed-width palette (64-col) with label truncation; query row no longer nests a border. ANSI clear-screen on `noir tui`/`noir palette` entry. `.superpowers/` removed. Gates green (1539 tests).
- **v1.9.4 (2026-08-10)** — **C3 skills enhancement.** Skill pack curated 34→26, runtime-derived registry, structural quality gate, offline evals harness. Gates green (1561 tests). C3 → Completed.
- **v1.10.0 (2026-08-11)** (published 2026-08-11, dist-tag `latest`), alongside **v1.10.0-beta.1** (`beta`). **C4 Completed** — all 6 deltas implemented across 6 slices: surface wiring (resume + taskClass/PRD gate + quick mode + blocked/abandon + config bridge), verify-gate recovery (evidence-backed verify gate + HARD/SOFT tiering + document wiring), research grounding (soft research sub-step + clarify gating), project discovery (two-half PM + CI + AI-tooling probe), decomposition (SlicePlan schema + `noir task decompose`), and release phase (`noir release` guided orchestrator). Gates green (1614 tests). C4 → Completed.
- **v1.10.1 (2026-08-13)** (published 2026-08-13, dist-tag `latest`), alongside **v1.10.1-beta.1** (`beta`). **C3 generated-artifact standard.** One naming/frontmatter/outline contract for every `.noir/` file a C3 skill generates: `<CODE>-<NNNN>-<taskId>-<slug>.md` with a 12-kind registry (`packages/core/src/artifacts.ts`), canonical frontmatter (`kind`/`id`/`slug`/`title`/`status`/`date`/`generated_by`/`generated_at`), per-type outlines (SPEC/PLAN/TASK/ANALYSIS/ADR full; PRD reconciled to the 9-section canon), and gate enforcement (`artifactPathDrift` hard-fails skill bodies naming a non-canonical `.noir/` path). Fixed 4 skills' naming drift + the phantom `.noir/sdd/`. ADR-0007. Gates green (1622 tests).
- **v1.11.0 (2026-08-14)** — **v2 orchestrator TUI.** Single command surface (home/help/search merged into one corpus-aware palette: `commands`/`output`/`help`, Tab-switched; `h`/`?`/`Ctrl+F` open it at a corpus; unified `useInput`); unified recents (shell recall + palette share `tui-history.json`); destructive confirm now covers typed `/command`; `noir run <prompt>` headless host-driving (stream-json, token/cost max-per-message.id reducer, `--command` custom-profile override, transcript to `.noir/transcripts/`); home-menu update-available notice with install-type-specific advice. ADR-0008. Gates green (1647 tests).

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
- Programmatic headless driving of host CLIs (single-shot shipped via `noir run` in 1.11.0; multi-step orchestration from the TUI remains).
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
| Programmatic host-driving — multi-step orchestration from the TUI | v2.0 | Single-shot headless driving shipped as `noir run` in 1.11.0; multi-step TUI orchestration remains. |
| Full theming + plugin SDK | v1.x / v2.0 | Polish/en extensibility after core is solid. |

---

## How to use this file

- **When shipping a version:** add the release to `CHANGELOG.md` (root) and run `pnpm release:history` to update the registry; advance the "Current status" block and version targets here.
- **When direction changes:** update the vision + version targets, and record the *why* as an ADR in `docs/decisions/`.
- **When tempted to add scope:** check the Deferred table — if it is listed, it is intentional; add new deferrals here rather than dropping them silently.
