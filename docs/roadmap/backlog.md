# Backlog

> **Living record.** Deferred engineering work, grouped by area. Each item was intentionally out of a past version to keep scope sharp; none are abandoned. When a capability doc says "Gap / roadmap delta", the concrete engineering item lives here (or in the capability doc itself when it is capability-specific).

This backlog is the consolidation of the former `docs/roadmap/` "v1.x backlog" plus verified gaps from the capability grounding (2026-08). Items marked **resolved** are historical — they shipped in the version named.

---

## Run orchestration + configuration surface (2026-08-19 → 1.12.0)

> **Implemented on `develop` 2026-08-19; ships as v1.12.0 (pending tag+publish)**: full CI gate green.

- ✅ **Palette help-corpus wrap** — RESOLVED: two-column hint width derived from the real row budget (58), active help row shows the full description as a `↳` detail line.
- ✅ **`noir run` host-failure contract** — RESOLVED: API-error assistant events flagged + never streamed as answers; `result.is_error` surfaced; failed runs exit 1 + `{ok:false}` under `--json` + actionable auth/ENOENT messages; no misleading usage line on failure.
- ✅ **Run profiles** — RESOLVED: `run.profiles` + `--profile`/`--list-profiles`/`NOIR_PROFILE`/`run.defaultProfile`; `${VAR}` env expansion; unknown-name errors list available profiles.
- ✅ **Shell-alias resolution fallback** — RESOLVED: ENOENT on `--command` probes the user's shell; PATH entries respawned directly; aliases/functions bridged with the prompt only as argv.
- ✅ **`.noir/.env` loading** — RESOLVED: core parser (Node --env-file dialect), loaded at CLI + daemon start, real env wins, gitignored via the managed block, `.env.example` scaffolded, doctor permission check.
- ✅ **Configuration documentation overhaul** — RESOLVED: `.describe()` on every schema field + nested generator walk → self-maintaining `config.md`; new `environment.md` / `clickup.md` / `host-profiles.md`; `noir run` section in getting-started; update-cache path + memory-hooks template drift fixed. **Also resolved the user-facing confusion:** `CLICKUP_TEAM_ID` is a dead env var (nothing reads it) — team binding is `integrations.clickup.teamId`; the docs now say so explicitly.

## Workflow / lifecycle (C4)

> **Shipped 2026-08-11** — all 6 C4 slices implemented across 8 commits. Full gate green (lint/build/typecheck/test 1593/docs:validate). Each item below was resolved in this session.

- ✅ **c4-surface-wiring** — RESOLVED (2026-08-11): `noir task resume` + `workflow_resume`; `taskClass` plumbed (`noir task new --class` / `workflow_start taskClass`); quick-mode `runQuick` wired; `workflow_block`/`workflow_abandon` + `noir task block|abandon`; `prd.mandatoryFor` config bridge (`resolveGateConfig`). — [`2026-08-11-c4-surface-wiring-design.md`](../internal/specs/2026-08-11-c4-surface-wiring-design.md)
- ✅ **c4-verify-gate-recovery** — RESOLVED (2026-08-11): evidence-backed verify gate (`GateEvidence` + `failed` decision; default OFF); `noir task verify` runs configured checks + submits evidence; HARD blocks/SOFT nudges; block-and-offer-recovery; document-phase wiring (changelog + decision-record stubs on `done`, `--no-artifacts`). — [`2026-08-11-c4-verify-gate-recovery-design.md`](../internal/specs/2026-08-11-c4-verify-gate-recovery-design.md)
- ✅ **c4-research-grounding** — RESOLVED (2026-08-11): soft research sub-step (`research:<taskId>` records, NOT a hard FSM state), `noir task research-record` CLI + `workflow_research_record` MCP tool, clarify gating + `writeClarifications` artifact. — [`2026-08-11-c4-research-grounding-design.md`](../internal/specs/2026-08-11-c4-research-grounding-design.md)
- ✅ **c4-project-discovery** — RESOLVED (2026-08-11): two-half PM detection (packageManager field > lockfile > user-agent, conflict surfaced), CI detection + existing-AI-tooling probe (never clobber). — [`2026-08-11-c4-project-discovery-design.md`](../internal/specs/2026-08-11-c4-project-discovery-design.md)
- ✅ **c4-decomposition** — RESOLVED (2026-08-11): `SlicePlan`/`Slice` schema with deterministic validation (duplicate ID, missing field, dependency cycles, parallel file conflicts); `noir task decompose` CLI (offline template). — [`2026-08-11-c4-decomposition-design.md`](../internal/specs/2026-08-11-c4-decomposition-design.md)
- ✅ **c4-release-phase** — RESOLVED (2026-08-11): `noir release <version>` guided orchestrator (preflight→bump→gate→commit→CI→beta-tag→hands off at human-approval gates). Build-once/idempotent (tags immutable). — [`2026-08-11-c4-release-phase-design.md`](../internal/specs/2026-08-11-c4-release-phase-design.md)

## Daemon / runtime

- **Socket activation** for the daemon (systemd-style auto-start on first connect) — not yet implemented; real `--detach` backgrounding shipped in 1.8.0 (ADR-0006), but the daemon is not socket-activated.
- **Auth token for the daemon transport** — today only localhost host+origin validation; no token.
- **Per-project `daemon.json`** — today a single global `~/.noir/daemon.json` clobbers under concurrent projects.
- **Fixed/configured daemon port** — `daemon.port` config is parsed (and tested) but never consumed; the daemon binds an ephemeral 127.0.0.1 port each start.
- **Background worker architecture** — indexing is on-demand today; no scheduled workers for cleanup, update-checks, docs sync, or integration polling.
- **Event bus / pub-sub observability** — today observability is status tools + `.noir/audit/` JSONL; no structured metrics/tracing endpoints.

## CLI / TUI

- **v2 orchestrator TUI (Archetype B)** — **RESOLVED in 1.11.0 (2026-08-14, ADR-0008):** single-surface palette consolidation (home/help/search merged into one corpus-aware palette) + `noir run` headless host-driving (stream-json + token/cost max-per-message.id reducer + custom `--command` profile + transcript). Remaining open: fullscreen alternate-screen + native mouse (dropped by research — ADR-0008 §6), a full TUI session/transcript picker.
- **Interactive forms/wizards** in the TUI — beyond the current palette + confirm.
- **`task` id/slug distinction** — collapsed to a single slug namespace for v1.

## Context

- **tree-sitter symbol-aware code chunking** (line/token-bounded chunking ships today).
- **Full `.gitignore` parsing** (a static denylist ships today).
- **`trigram` tokenizer for FTS5** (`porter unicode61` today; splits camelCase poorly).
- **`--watch` full daemon wiring.**
- **Remote embedding provider SDK completion** (current stubs).
- **Embedding model upgrade** (`bge-small-en-v1.5`, same 384-dim).

## Memory

- **Graph / temporal-KG expansion** (Zep/Graphiti-style entities + edges; needs an extraction LLM + graph storage).
- **LLM auto-tagging** (`concepts` / `type` on save).
- **Auto-capture-by-default** — an opt-in Claude Code hooks template ships today (never auto-wired), documenting the explicit-save surface. The `memory capture` command does not exist yet (the template says so); auto-capture is a future slice.
- **Multi-user / org scoping** (per-user memory namespaces; v1 is solo power-user).

## Model

- **OS keychain for secrets** (env vars today).
- **Prompt caching** (Anthropic `cache_control`).
- **Provider-native JSON strict mode** (OpenAI `response_format: strict` / Anthropic forced-tool).
- **`onUsage` usage sink** (fires on success; `noir doctor` wiring deferred).
- **Streaming** (single-shot by design today; agent loops forbidden by D5).
- **`draftPrd` runtime consumer** — the shipped bounded-model layer's only runtime caller is memory consolidation; `draftPrd` is exported but test-only.

## Toolchain / quality

- **`tsconfig.test.json`** — piloted on `@noir-ai/cli`; the remaining 10 packages are still `src`-only.
- ✅ **`references/` skill code-path coverage** — resolved in C3 (2026-08-10): `noir-clickup` carries `references/clickup-api.md` as a real shipped reference.
- **Engine-naming consistency** (`ContextEngine` / `MemoryEngineImpl`).
- **`indexer.ts` + `daemon/server.ts` god-file refactors.**
- **`biome.json` schema deprecation infos** (drift between biome's config schema and the pinned version).
- **First-run model download UX** (one-time ~22 MB fetch, cached in `~/.noir/models/`).
- **Repository health checker** — duplicates/stale/orphan detection beyond `docs:validate`.
- **Benchmark suite + perf regression gate** — no performance measurement of any kind today.
- **Engineering metrics collection** — build/test/lint duration, coverage, tech-debt tracking.
- **Automated changelog generation** — `CHANGELOG.md` is hand-maintained.
- **Dependency-update automation** (no dependabot/renovate).

## Distribution (from C1 grounding)

- **winget / Chocolatey manifests** — deferred by decision (ADR-0005). Windows is covered by `install.ps1` (primary), Scoop, and npm; revisit if Windows user demand surfaces.
- **Per-channel update cache** — `~/.noir/update-cache.json` records a single channel; cross-channel isolation is enforced by `latestVersionFromCache` (null on mismatch), but a `Record<channel, version>` shape was deliberately not adopted to preserve the committed `UpdateCache` interface.
- **`migrationNotes` / `breakingChanges` / `securityAdvisory`** — structured release metadata beyond `changelogRef` is not yet captured in the registry. `changelogRef` is populated for every entry.
- **Windows native-install bugs (deferred from the 1.7.3 audit)** — all PRE-EXISTING (not regressions), surfaced by the 23-agent pre-release audit, not fixed in 1.7.3 because they need a Windows VM to verify and Windows is excluded from the CI smoke matrix (better-sqlite3@13 SHIPS win32 N-API prebuilds, but the pnpm approved-builds gate can still trigger a node-gyp build needing VS Build Tools):
  - win32 managed-Node provisioning computes `npmBin = …/npm.exe` (`node-provision.ts` `binName`), but Node Windows distributions ship `npm.cmd` (not `npm.exe`) → `noir install`/`update` on Windows fails the npm step with ENOENT. `install.ps1` and `probeSystemNode` already use `npm.cmd`.
  - win32 extraction shells out to external `unzip` (`node-provision.ts:228`), which is not present on a stock Windows install (PowerShell ships `Expand-Archive`) → the managed-runtime path always degrades to the system-Node fallback on Windows. (`install.ps1` is correct; only the CLI `noir install`/`update` path is affected.)
  - `install.ps1` lacks the auto-PATH + PATH-shadow-detection parity that `install.sh` gained (it only prints a copy-paste `SetEnvironmentVariable` command and reports "on PATH" even when a stale npm-global `noir.cmd` shadows the new shim).
  - Scoop manifest `bin: [["dist/bin.js", "noir"]]` points a Windows shim directly at a `.js` file with no `node` invocation — may need a `pre_install` that builds a `.cmd` wrapper (mirroring `install.ps1`).

---

- **Resolved in v1.9.4 (C3, 2026-08-10):** Skill pack curated 34→26 via 5 merges + gerund renames; all 26 builtins + 1 integration become full playbooks (zero stubs, WHAT+WHEN descriptions, follow-up guidance, host-tool maximization). Runtime-derived registry queryable via `noir skills registry --json`. Structural quality gate (`validateSkill` + `lintSkill` + `noir skills lint`). Offline evals harness (`evals/evals.json` + vitest runner, 2 shipped examples). ClickUp integration enhanced (STEP-0 auth gate, 14 API pitfalls, verb dispatch, attachment handling). SessionStart hook bootstrap at `noir init` + NOIR.md amplifier + router contract. Full gate green (1561 tests). K3 (skills-compiler generalization → `discoverIntegrations` + `integration.json`, landed in Slice X); R4/R5 (`rules:` config block + `noir doctor` RULES.md budget check); P3/P4 (`draftPrd` + `prd:` config + `advance()` soft PRD gate); Workflow dual-source-of-truth collapse (W1) + vestigial checkpoint (W2) + S4 nits (W3); Context kNN-only-hit snippet hydration (C1); Toolchain stale-skill-dir cleanup (T2) + `tsconfig.test.json` pilot (T1); lint → 0.
- **Resolved in v1.2.0-beta.1:** S10 multi-host (`resolveAdapter`, `HostId` enum, `--host` flag, 4 new adapters, universal `AGENTS.md`); S11 SDK/doctor remainder (`docs/reference/packages.md`, `noir doctor` `publish` check).
- **Resolved in 1.4.0-beta.1:** universal conflict contract routing every producer through one `onConflict` seam; `assertNotUserOwned`-guarded orphan cleanup.
- **Resolved in the C1 native-installer line (published in 1.7.0, 2026-08-04):** CLI self-update / version management — `noir update` + async cached startup version check (24h default; `NOIR_DISABLE_UPDATE_CHECK`/`NOIR_DISABLE_UPDATES` kill-switches; semver downgrade guard). Native installer path — managed-Node `install.sh` (POSIX) + `install.ps1` (Windows PowerShell): provision a pinned Node 22.x runtime under `~/.noir/`, isolated prefix, `noir` shim, `install.json` record; no system Node, no admin. `noir install`/`migrate` — move an existing install to native, settings preserved, `--uninstall-prev` explicit (never auto-uninstalls); one-time migration banner + `--dismiss`. `noir doctor` install row (advisory `ok`/`warn`, never `fail`, no network). Homebrew formula (`packaging/homebrew/noir.rb`) — real url/sha256/version from the 1.6.0 tarball (was a placeholder). Scoop manifest (`packaging/scoop/noir.json`). Installer trust — `SHA256SUMS` + Sigstore build-time attestation per release (`gh attestation verify`). Decision record: ADR-0005.
- **Resolved in the C1 managed-Node provisioning line (published in 1.7.0, 2026-08-04):** Managed-Node auto-provisioning — `provisionManagedNode()` in `@noir-ai/core` (`packages/core/src/node-provision.ts`): download + SHA256 verify (fail-closed) + extract Node 22.23.2 LTS into `~/.noir/runtime/v<version>/`; atomic writes (staging → rename); auto-cleanup old runtime versions. `MANAGED_NODE_VERSION` constant exported from core, shared with `install.sh`/`install.ps1` via `scripts/node-version.env`. `noir install`/`migrate` now calls `provisionManagedNode()` — CLI can bootstrap without a shell script. `downloadAndVerify()` / `extractNode()` / `detectNodeTarget()` / `nodeArchiveUrl()` exported as callable pipeline. CI `node-provision-smoke` job validates real Node download. Release registry rebuilt: accurate channel labels (`stable`/`beta`) and non-null `changelogRef` for every entry; `scripts/release-registry.mjs` `buildEntry` derives channel/npmDistTag from release type. C1 capability → Completed.
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.1):** two post-1.7.0 user-facing bugs — **`noir_clickup_write` MCP tool rename** (the dotted name violated the MCP tool-name charset `[a-z0-9_-]`; the host rejected `tools/list` and the whole MCP session failed with `-32000`; renamed repo-wide + charset regression guard, `fix(daemon)` `368b766`) and **piped `install.sh` `curl | bash` fix** (`${BASH_SOURCE[0]}` is empty when piped → `node-version.env` not found; now fetched from the repo raw URL, `fix(dist)` `23d4f19`).
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.2):** three post-1.7.1 bugs — **dynamic-require crash in `noir init --upgrade`** (`cli/conflict.ts` lazy `require('@noir-ai/create')` survived tsup bundling as an ESM-incompatible `__require` shim; only fired on the conflict path; static import fix, `fix(cli)` `2c6fc63`), **`.mcp.json` absolute native-shim path** (GUI MCP clients like VS Code launched from the Dock don't read shell profiles → `spawn noir ENOENT`; `resolveNoirCommand()` emits the absolute `~/.noir/bin/noir` when a native install is detected, `fix` `2f28f91`), and **installer UX** (`install.sh` PATH-shadow detection `5964a38` + auto-add shell profile `b4e6bb9`).
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.3):** four post-1.7.2 fixes from systematic debugging + a 23-agent pre-release audit workflow — the bundling `require()` class fix (`crypto`/`fs` latent crashes), native-install `chmod +x` shim + spinner UX, opencode `opts.command` threading, and store `busy_timeout = 5000`. Table-driven cross-adapter parity test (+11 tests → 1439).
- **Resolved in the 2026-08-05 bugfix line (on `develop`, shipped in 1.7.4):** shim exec-bit defense-in-depth — `atomicWriteFile()` (core) preserves the existing file's POSIX mode across overwrites (rewrite of an already-executable shim keeps `0o755` regardless of which binary version performs the write); `ensureShimExecutable()` (core) re-asserts `0o755` after every install/update (a freshly-installed binary heals its own shim even if the OLD updater forgot to chmod). Closes the chicken-and-egg "noir update → permission denied" bug permanently. (`fix(core,cli)` `c458770`)
- **Resolved in the C2 TUI-delta line (shipped in 1.8.0, 2026-08-05):** daemon `start --detach` real backgrounding (detached `--_detached-child` + `mode:'detached'` record + bounded `/health` probe); `Ctrl+K` command palette (commander-tree-derived registry + hand-rolled fuzzy matcher behind a swap seam) + searchable output (`Ctrl+F`, `n`/`N`) + persistent recent commands (`~/.noir/<projectId>/tui-history.json`, capped + `NOIR_DISABLE_TUI_HISTORY` opt-out) + in-TUI destructive confirmation + input-history recall; `context index --force` → full reindex (`context.reindex()`); `--dry-run`/`--preview` on `init`/`create`/`sync`; in-process read-only fallback for `context`/`memory`/`task` reads when the daemon is down (`withInProcessRead`, single-writer preserved); repo-hygiene cleanup (dangling `docs/command-policy.md`/`docs/deprecation.md` refs removed from `bin.ts`). Decision: ADR-0006. (Socket activation + interactive forms/wizards remain open.)
- **Resolved in the 1.9.1 patch (shipped 2026-08-07):** home-menu crash fix. Bare `noir` Level-1 section picker used `@clack/prompts` `selectKey` (select-by-typed-letter, no arrow/enter/esc; `_track=false` → `value=undefined` → Enter crashes `Cannot read properties of undefined (reading 'label')`). Fix: upgraded `@clack/prompts` `^0.7.0 → ^1.7.0` (core 1.4.3; Esc→cancel native via `settings.aliases`, empty-options handling, ESM-only), switched both menu levels to `select`. One API break (`validate` string→string|undefined in `memory.ts`). `HomeSection.key` filed as legacy (no longer read, kept for TUI/test compat). Gates green (1539 tests, 0 regression).
- **Resolved in the 1.9.2 patch (shipped 2026-08-07/08):** TUI visual clarity. Every TUI surface (dashboard, home menu, palette, search, confirm, help) redrawn with `╭─╮│╰╯` rounded borders + dim dividers; command input / palette query / confirm prompt each get a bordered field; output pane truncates to `contentWidth()` (terminal − border − padding) with `wrap="truncate-end"` so the `noir status` table no longer overflows or wraps. New `contentWidth()` + `divider()` helpers centralize the width budget. Presentational only (no logic/keybinding change). Gates green (1539 tests, 0 regression).

---

## How to use this file

- **When an item ships:** move it to the "History of resolutions" section with the version.
- **When adding debt:** give it a one-line description and an owner area (the grouping above).
- **Cross-reference:** capability docs link here for the "Gap / roadmap delta" items they own.
