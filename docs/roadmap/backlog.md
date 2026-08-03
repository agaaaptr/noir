# Backlog

> **Living record.** Deferred engineering work, grouped by area. Each item was intentionally out of a past version to keep scope sharp; none are abandoned. When a capability doc says "Gap / roadmap delta", the concrete engineering item lives here (or in the capability doc itself when it is capability-specific).

This backlog is the consolidation of the former `docs/roadmap.md` "v1.x backlog" plus verified gaps from the capability grounding (2026-08). Items marked **resolved** are historical — they shipped in the version named.

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

- **CLI self-update / version management** — no `noir update`/`upgrade`, no startup version check.
- **Complete + publish the Homebrew formula** — `packaging/homebrew/noir.rb` is a placeholder (Node-for-Formula-Authors; url/sha256/version TBD).
- **Scoop / Winget / Chocolatey manifests** — none exist.
- **Native/binary installer path** — today `scripts/install.sh` delegates to `npm install -g`; bootstrap/rollback/uninstall/repair/self-update are not implemented.
- **Migration-recommendation messaging** in the CLI.
- **Richer release metadata** — `changelogRef` is null on every registry entry; migration notes / breaking changes / security advisory are not captured.
- **Reconcile registry channel mislabels** — `1.4.0`/`1.5.0` rows carry `channel: beta` despite being stable publishes.

---

## History of resolutions

- **Resolved in v1.1.0-beta.1:** K3 (skills-compiler generalization → `discoverIntegrations` + `integration.json`, landed in Slice X); R4/R5 (`rules:` config block + `noir doctor` RULES.md budget check); P3/P4 (`draftPrd` + `prd:` config + `advance()` soft PRD gate); Workflow dual-source-of-truth collapse (W1) + vestigial checkpoint (W2) + S4 nits (W3); Context kNN-only-hit snippet hydration (C1); Toolchain stale-skill-dir cleanup (T2) + `tsconfig.test.json` pilot (T1); lint → 0.
- **Resolved in v1.2.0-beta.1:** S10 multi-host (`resolveAdapter`, `HostId` enum, `--host` flag, 4 new adapters, universal `AGENTS.md`); S11 SDK/doctor remainder (`docs/reference/packages.md`, `noir doctor` `publish` check).
- **Resolved in 1.4.0-beta.1:** universal conflict contract routing every producer through one `onConflict` seam; `assertNotUserOwned`-guarded orphan cleanup.

---

## How to use this file

- **When an item ships:** move it to the "History of resolutions" section with the version.
- **When adding debt:** give it a one-line description and an owner area (the grouping above).
- **Cross-reference:** capability docs link here for the "Gap / roadmap delta" items they own.
