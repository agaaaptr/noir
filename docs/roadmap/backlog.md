# Backlog

> **Living record.** Deferred engineering work, grouped by area. Each item was intentionally out of a past version to keep scope sharp; none are abandoned. When a capability doc says "Gap / roadmap delta", the concrete engineering item lives here (or in the capability doc itself when it is capability-specific).

This backlog is the consolidation of the former `docs/roadmap/` "v1.x backlog" plus verified gaps from the capability grounding (2026-08). Items marked **resolved** are historical — they shipped in the version named.

---

## Daemon / runtime

- **Background/detached daemon spawn + socket activation** — `noir daemon start --detach` is documented-but-refused today (exit 2, "tracked: v1.x").
- **Auth token for the daemon transport** — today only localhost host+origin validation; no token.
- **Per-project `daemon.json`** — today a single global `~/.noir/daemon.json` clobbers under concurrent projects.
- **Fixed/configured daemon port** — `daemon.port` config is parsed (and tested) but never consumed; the daemon binds an ephemeral 127.0.0.1 port each start.
- **Background worker architecture** — indexing is on-demand today; no scheduled workers for cleanup, update-checks, docs sync, or integration polling.
- **Event bus / pub-sub observability** — today observability is status tools + `.noir/audit/` JSONL; no structured metrics/tracing endpoints.

## CLI / TUI

- **Richer Ink TUI widgets** — the `noir tui` MVP dashboard (StatusBar/OutputPane/CommandInput/Header/Footer) shipped; command palette, searchable command index, command history, interactive forms/wizards, in-TUI confirmation dialogs are still deferred.
- **In-process read-only store fallback** for `context`/`memory`/`task` commands — daemon-required today; `status` is the only probe-only command.
- **`noir context index --force` honored** — the flag is recognized but not wired (daemon always content-hash incremental).
- **`--dry-run` / `--preview` on init/create/sync** — `ScaffoldOptions.dryRun` exists but is not surfaced on the CLI.
- **`task` id/slug distinction** — collapsed to a single slug namespace for v1.
- **Repo hygiene** — `packages/cli/src/bin.ts.bak` is a stale tracked backup; bin.ts comments reference `docs/command-policy.md` + `docs/deprecation.md` which do not exist.

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
- **Auto-capture-by-default** — an opt-in Claude Code hooks template ships today (never auto-wired); CLI/docs mismatch: the template says `noir memory capture --stdin` but the CLI exposes only recall/save/sessions/forget/consolidate.
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
- **`references/` skill code-path coverage** (only synthetic fixtures today; 0 shipped skills use it).
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
- **Per-channel update cache** — `~/.noir/update.json` records a single channel; cross-channel isolation is enforced by `latestVersionFromCache` (null on mismatch), but a `Record<channel, version>` shape was deliberately not adopted to preserve the committed `UpdateCache` interface.
- **`migrationNotes` / `breakingChanges` / `securityAdvisory`** — structured release metadata beyond `changelogRef` is not yet captured in the registry. `changelogRef` is populated for every entry.
- **Windows native-install bugs (deferred from the 1.7.3 audit)** — all PRE-EXISTING (not regressions), surfaced by the 23-agent pre-release audit, not fixed in 1.7.3 because they need a Windows VM to verify and Windows is excluded from the CI smoke matrix (better-sqlite3@13 is source-only; the runner lacks VS Build Tools):
  - win32 managed-Node provisioning computes `npmBin = …/npm.exe` (`node-provision.ts` `binName`), but Node Windows distributions ship `npm.cmd` (not `npm.exe`) → `noir install`/`update` on Windows fails the npm step with ENOENT. `install.ps1` and `probeSystemNode` already use `npm.cmd`.
  - win32 extraction shells out to external `unzip` (`node-provision.ts:228`), which is not present on a stock Windows install (PowerShell ships `Expand-Archive`) → the managed-runtime path always degrades to the system-Node fallback on Windows. (`install.ps1` is correct; only the CLI `noir install`/`update` path is affected.)
  - `install.ps1` lacks the auto-PATH + PATH-shadow-detection parity that `install.sh` gained (it only prints a copy-paste `SetEnvironmentVariable` command and reports "on PATH" even when a stale npm-global `noir.cmd` shadows the new shim).
  - Scoop manifest `bin: [["dist/bin.js", "noir"]]` points a Windows shim directly at a `.js` file with no `node` invocation — may need a `pre_install` that builds a `.cmd` wrapper (mirroring `install.ps1`).

---

## History of resolutions

- **Resolved in v1.1.0-beta.1:** K3 (skills-compiler generalization → `discoverIntegrations` + `integration.json`, landed in Slice X); R4/R5 (`rules:` config block + `noir doctor` RULES.md budget check); P3/P4 (`draftPrd` + `prd:` config + `advance()` soft PRD gate); Workflow dual-source-of-truth collapse (W1) + vestigial checkpoint (W2) + S4 nits (W3); Context kNN-only-hit snippet hydration (C1); Toolchain stale-skill-dir cleanup (T2) + `tsconfig.test.json` pilot (T1); lint → 0.
- **Resolved in v1.2.0-beta.1:** S10 multi-host (`resolveAdapter`, `HostId` enum, `--host` flag, 4 new adapters, universal `AGENTS.md`); S11 SDK/doctor remainder (`docs/reference/packages.md`, `noir doctor` `publish` check).
- **Resolved in 1.4.0-beta.1:** universal conflict contract routing every producer through one `onConflict` seam; `assertNotUserOwned`-guarded orphan cleanup.
- **Resolved in the C1 native-installer line (published in 1.7.0, 2026-08-04):** CLI self-update / version management — `noir update` + async cached startup version check (24h default; `NOIR_DISABLE_UPDATE_CHECK`/`NOIR_DISABLE_UPDATES` kill-switches; semver downgrade guard). Native installer path — managed-Node `install.sh` (POSIX) + `install.ps1` (Windows PowerShell): provision a pinned Node 22.x runtime under `~/.noir/`, isolated prefix, `noir` shim, `install.json` record; no system Node, no admin. `noir install`/`migrate` — move an existing install to native, settings preserved, `--uninstall-prev` explicit (never auto-uninstalls); one-time migration banner + `--dismiss`. `noir doctor` install row (advisory `ok`/`warn`, never `fail`, no network). Homebrew formula (`packaging/homebrew/noir.rb`) — real url/sha256/version from the 1.6.0 tarball (was a placeholder). Scoop manifest (`packaging/scoop/noir.json`). Installer trust — `SHA256SUMS` + Sigstore build-time attestation per release (`gh attestation verify`). Decision record: ADR-0005.
- **Resolved in the C1 managed-Node provisioning line (published in 1.7.0, 2026-08-04):** Managed-Node auto-provisioning — `provisionManagedNode()` in `@noir-ai/core` (`packages/core/src/node-provision.ts`): download + SHA256 verify (fail-closed) + extract Node 22.23.2 LTS into `~/.noir/runtime/v<version>/`; atomic writes (staging → rename); auto-cleanup old runtime versions. `MANAGED_NODE_VERSION` constant exported from core, shared with `install.sh`/`install.ps1` via `scripts/node-version.env`. `noir install`/`migrate` now calls `provisionManagedNode()` — CLI can bootstrap without a shell script. `downloadAndVerify()` / `extractNode()` / `detectNodeTarget()` / `nodeArchiveUrl()` exported as callable pipeline. CI `node-provision-smoke` job validates real Node download. Release registry rebuilt: accurate channel labels (`stable`/`beta`) and non-null `changelogRef` for every entry; `scripts/release-registry.mjs` `buildEntry` derives channel/npmDistTag from release type. C1 capability → Completed.
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.1):** two post-1.7.0 user-facing bugs — **`noir_clickup_write` MCP tool rename** (the dotted name violated the MCP tool-name charset `[a-z0-9_-]`; the host rejected `tools/list` and the whole MCP session failed with `-32000`; renamed repo-wide + charset regression guard, `fix(daemon)` `368b766`) and **piped `install.sh` `curl | bash` fix** (`${BASH_SOURCE[0]}` is empty when piped → `node-version.env` not found; now fetched from the repo raw URL, `fix(dist)` `23d4f19`).
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.2):** three post-1.7.1 bugs — **dynamic-require crash in `noir init --upgrade`** (`cli/conflict.ts` lazy `require('@noir-ai/create')` survived tsup bundling as an ESM-incompatible `__require` shim; only fired on the conflict path; static import fix, `fix(cli)` `2c6fc63`), **`.mcp.json` absolute native-shim path** (GUI MCP clients like VS Code launched from the Dock don't read shell profiles → `spawn noir ENOENT`; `resolveNoirCommand()` emits the absolute `~/.noir/bin/noir` when a native install is detected, `fix` `2f28f91`), and **installer UX** (`install.sh` PATH-shadow detection `5964a38` + auto-add shell profile `b4e6bb9`).
- **Resolved in the 2026-08-04 bugfix line (shipped in 1.7.3):** four post-1.7.2 fixes from systematic debugging + a 23-agent pre-release audit workflow — the bundling `require()` class fix (`crypto`/`fs` latent crashes), native-install `chmod +x` shim + spinner UX, opencode `opts.command` threading, and store `busy_timeout = 5000`. Table-driven cross-adapter parity test (+11 tests → 1439).
- **Resolved in the 2026-08-05 bugfix line (on `develop`, shipped in 1.7.4):** shim exec-bit defense-in-depth — `atomicWriteFile()` (core) preserves the existing file's POSIX mode across overwrites (rewrite of an already-executable shim keeps `0o755` regardless of which binary version performs the write); `ensureShimExecutable()` (core) re-asserts `0o755` after every install/update (a freshly-installed binary heals its own shim even if the OLD updater forgot to chmod). Closes the chicken-and-egg "noir update → permission denied" bug permanently. (`fix(core,cli)` `c458770`)

---

## How to use this file

- **When an item ships:** move it to the "History of resolutions" section with the version.
- **When adding debt:** give it a one-line description and an owner area (the grouping above).
- **Cross-reference:** capability docs link here for the "Gap / roadmap delta" items they own.
