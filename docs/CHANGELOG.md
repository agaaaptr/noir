# Changelog

Notable changes to the Noir toolkit, newest first. Slices follow the roadmap (`docs/roadmap.md`); per-slice design lives in `docs/superpowers/specs/`.

## 1.2.0-beta.2 (2026-07-26)

**Published on npm (dist-tag `beta`); verified working via global install** — `npx @noir-ai/cli@1.2.0-beta.2 --version` → `1.2.0-beta.2` (exit 0); `noir init` scaffolds. The critical global-install fix:

**Critical fix: a global `noir` install was a silent no-op** (every published beta, including 1.2.0-beta.1). Two bugs:

- **Symlinked-bin silent exit (critical):** the `isMainModule` guard compared `pathToFileURL(process.argv[1]).href` to `import.meta.url`. A global npm install invokes the bin through a symlink (`…/bin/noir` → `…/lib/node_modules/@noir-ai/cli/dist/bin.js`), so `argv[1]` is the symlink path while `import.meta.url` is the resolved real path — they never matched, `main()` never ran, and `noir` exited 0 with **no output**. **Fix:** `realpathSync(argv[1])` before comparing. (Direct `node bin.js` worked because `argv[1]` was already the real path — which is why the in-repo dogfood never caught it; the regression test now spawns the bin via a symlink.)
- **`--version` exit code:** commander v12 throws error code `commander.version` (not `commander.versionDisplayed`); the exit-code mapper missed it, so `noir --version` exited 2 (usage) instead of 0. **Fix:** map `commander.version` → exit 0.

### Fixed
- `noir --version` / `--help` / `init` / `create` / bare `noir` now work when installed **globally** (symlink invocation). A regression test (`global-install symlink invocation`) guards both fixes.

---

## 1.2.0-beta.1 (2026-07-26)

**Multi-host (S10) ships on the beta channel.** Noir is now cross-CLI: Claude Code stays the default, and **Gemini, Cursor, OpenCode, and AGENTS.md** are one `--host` flag away. Supersedes `1.1.0-beta.1` on the `beta` dist-tag. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`. **11 packages** (unchanged); **1089/1089 tests** (was 966 at 1.1.0-beta.1); build / typecheck / lint (0 warnings) green. Design record: `docs/superpowers/specs/2026-07-25-s10-multihost-design.md`; the locked decisions in [ADR-0004](decisions/0004-multi-host-adapters.md).

### Added — S10 multi-host adapters
- **Adapter registry.** `resolveAdapter(host: HostId): HostAdapter` in `@noir-ai/adapters` — a `Record<HostId, HostAdapter>` map with an exhaustiveness guard. `HostId = 'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode'` (one owner; core/skills redeclare the literals). `SUPPORTED_HOSTS` — a frozen iteration list the CLI `--host` flag's `.choices(...)` and `noir doctor` consume. The CLI's 8 direct `claudeAdapter` imports collapsed to one `resolveAdapter(host)` call; adding a host needs no CLI edits beyond the flag enum.
- **`host:` config widens** from `z.literal('claude')` to `z.enum(['claude','agents-md','gemini','cursor','opencode']).default('claude')`. `claude` is the **default and the regression anchor** — a bare `noir init` is byte-equivalent to pre-multi-host (existing init/skills/doctor tests stay green). `CompileTarget` widens to the same enum so the skills compiler transforms per host.
- **`--host <id>` flag** on `noir init` / `noir create` / `noir sync` (default `claude`; commander rejects unknown values as `usage=2`). The choice persists into `.noir/config.yml`; `noir sync` reads it back (pass `--host` to override — advanced, not written back to config). `noir doctor` reports the **active host** and verifies host-specific artifacts (a `host:{active, expected, missing}` check).
- **4 new adapters:**
  - **`agents-md`** — the 32-platform universal standard. Root `AGENTS.md` (context + rules unified) + a broadly-compatible `.mcp.json`. No skills dir.
  - **`gemini`** — `GEMINI.md` (Gemini's native `@import` form, rules folded in) + root `AGENTS.md` + `.gemini/mcp.json`. No skills dir.
  - **`cursor`** — `AGENTS.md` + `.cursor/rules/*.mdc` (skills compile to **flat** `.mdc` with YAML frontmatter `description`/`alwaysApply:false`; the `@.noir/rules/RULES.md` import in AGENTS.md is cursor's rules surface — no separate host-rules pointer) + `.cursor/mcp.json`.
  - **`opencode`** — `AGENTS.md` + `opencode.json`. **Distinct MCP shape:** OpenCode's `mcp` block entries are `type`-tagged (`{type:'local', command:[...]}` stdio / `{type:'remote', url}` HTTP), not the `{mcpServers:{...}}` family; the emitted file stamps `$schema: https://opencode.ai/config.json`. Schema verified against `https://opencode.ai/docs/mcp-servers/`. No skills dir.
- **Universal `AGENTS.md` emitter (shared helper).** `emitAgentsMd(ctx)` produces byte-identical `AGENTS.md` content for every host: a heading + a 3-line inline fallback summary + `@.noir/NOIR.md` + `@.noir/rules/RULES.md` `@`-imports. The inline summary precedes the imports so readers that do not resolve `@`-imports still get a one-glance pointer; the imports remain canonical for hosts that do (Cursor, Codex, Junie, …).
- **No-duplication gating.** AGENTS.md is always emitted (every host reads it), but hosts with a native context file (`claude`→`CLAUDE.md`, `gemini`→`GEMINI.md`) keep it primary and **do not duplicate** content into AGENTS.md — the universal file carries only the canonical `@`-imports. One source (`.noir/`), never a drifting copy.

### Added — S11 remainder
- **[`docs/sdk.md`](sdk.md)** — the per-package framework/library API surface ("usable as a framework"): the stable barrels of `@noir-ai/{core,store,workflow,adapters,skills,context,memory,model}` with versioning + stability stance. Includes the `@noir-ai/adapters` `HostAdapter`/`resolveAdapter`/`SUPPORTED_HOSTS` surface.
- **`noir doctor` `publish` check** — advisory package-metadata validation across all `packages/*` (`name` `@noir-ai/*`, semver `version`, non-empty `files`, and `bin` for the cli). `warn` level, never `fail`.

### Fixed
- **`noir doctor` no longer reports a stale host list.** The host check is now adapter-driven (`resolveAdapter(host)` + each adapter's `agentsMdPath`/`mcpConfigPath`/`skillsDir`), so the expected-artifacts list matches the configured host exactly.

### Deferred (documented in `docs/roadmap.md` §v1.x backlog)
- `qwen` and `agy` adapters (the universal `AGENTS.md` covers them in the meantime).
- Multi-host emit (`hosts:[...]` → emit for several hosts at once). v1.x is single-host select.

---

## 1.1.0-beta.1 (2026-07-25)

**v1.x capabilities ship on the beta channel.** All 6 v1.x capability slices (**K/R/I/P/S/X**) are done on `develop`, plus a consolidated debt batch. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`. **11 packages** (added `@noir-ai/create`); **966/966 tests** (was 729 at 1.0.0-beta.1); build / typecheck / lint (0 warnings) green. Design record: `docs/specs/2026-07-25-v1x-capabilities-design.md` + per-slice specs in `docs/superpowers/specs/`.

The 6 v1.x capability slices extend one keystone refactor (`managedBlock` + shared `blockWriter` + `HostAdapter` emitters):
- **K** Keystone — `managedBlock(name, commentStyle)` factory + shared `blockWriter` (`writeManagedRegion`/`readManagedBlock`/`stripManagedBlock`/`commentStyleFor`) + `HostAdapter.emitRules` seam (pure refactor).
- **R** Rules — `.noir/rules/RULES.md` Noir-curated seed wired into `CLAUDE.md` via `RULES_BLOCK`; `noir-rules` skill.
- **I** Ignore — `IgnoreManager` + `syncIgnores` into init/sync (managed-block idempotent across `.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`).
- **P** PRD — `prd` artifact kind + `writePrd`/`readPrd` + `noir-prd` skill (no FSM change; explicit opt-in).
- **S** Scaffold — **new `@noir-ai/create`** package: three-mode writer (`regenerate`/`managedBlock`/`skipIfExists`) generalizing keystone-K `blockWriter`; declarative manifest; hand-rolled `{{var}}` templates; `.noir/scaffold-version`; migrations registry (inline-conflict, CI-safe); read-only stack-detect. CLI: `noir init`/`sync` refactored to consume the engine; **new `noir create [dir]`** (AI-layer only); `noir init --upgrade` (migrations); `noir doctor` scaffold-version drift. *Behavior changes (see §Behavior changes below).*
- **X** Integration — first-class integration layer (skill-only default + gated-write-proxy tier + full-runtime tier). First integration = **ClickUp**: `noir-clickup` skill (5-flow playbook + real `references/`) + `integration.json` (`runtime:'gated-write-proxy'`). `discoverIntegrations()` + `integration.json` Zod schema (the deferred **K3**); `discoverAll()` emits builtins+integrations (skill pack now **34** = 33 builtins + 1). Daemon `integrations_auth` MCP tool (resolves `CLICKUP_API_TOKEN` server-side at call time — kills the non-interactive-shell gotcha) + `noir.clickup_write` gated-write-proxy (**HARD confirm gate** dry-run→confirm→POST; allowlisted endpoints only; id-charset validation; 429 `X-RateLimit-Reset` backoff; audit JSONL to `.noir/audit/`). Core `integrations` config block (`runtime` downgrade honored); adapter `emitMcpConfig(ctx, opts, integration?)` overload.

### Added — debt batch (v1.x backlog resolved)
- **R4** core `rules:{enabled,lengthBudgetKb:6}` config block. **R5** `noir doctor` RULES.md budget check (warn >6 KB / >150 lines).
- **P3** `@noir-ai/model` `draftPrd(intake, clarify, memory)` (offline → 9-section template; `null` on no-provider/failure — graceful degradation). **P4** `prd:{mandatoryFor:[feature,epic]}` config + `advance()` SOFT ESCAPABLE PRD gate (observable in audit; never hard-blocks; `--force <reason>` escapable; quick-mode skips).
- **W1** workflow dual source of truth collapsed — `audit:<id>` KV authoritative, `task.history` now a derived view (single timestamp; drift gone). **W2** checkpoint wired to `writeAuditExport` (was vestigial; MCP tool contract preserved). **W3** S4 nits (`setBlocked` non-empty, jump no-op guard, `GateResultInput`/`GateResult` type split) + FSM coverage.
- **C1** kNN-only-hit snippet hydration + honest `mode:'knn'` (new `Indexer.readChunkContent`).
- **T2** stale-skill-dir cleanup on `noir sync` (prunes `.claude/skills/noir-*` not in the current pack).
- **T1** `tsconfig.test.json` **pilot** on `@noir-ai/cli` (typecheck now covers `test/`; 8 surfaced errors fixed; the other 9 packages remain `src`-only — documented follow-up).
- **Lint:** 10 pre-existing warnings → 0.

### Security — Slice X
Opus adversarial review (no CRITICAL; all IMPORTANT fixed + tested): confirm gate is HARD (no write without `confirm:true`; zero fetch on dry-run — asserted); token resolved at call time only, never logged/leaked (canary-tested on success + error paths); allowlist + id-charset enforced on every path-segment id (including config-derived); 429 backoff single-retry; audit JSONL one-line-per-executed-write. Fixed post-review: batch create-task `assignee`→`assignees` (plural — was silent data loss with `success:true` audit) + config `runtime:'none'` downgrade honored at registration (was inert). **Live-verified**: token resolves, `GET /user` → HTTP 200. CI stays cassette-only (no real network).

### Fixed (found in pre-release verification)
- **`noir doctor` no longer reports a CRITICAL store failure on a fresh project.** The store DB is created lazily on first daemon run, so a brand-new project (bare `noir init`/`create`, daemon never started) showed "1 critical check failed" + exit 1 on its first `noir doctor`. Now the store check **warns** ("not created yet — created when the daemon first runs") when the DB is absent on an otherwise-initialized project; only an existing-but-unopenable DB is a `fail`. Fresh-project `noir doctor` now exits 0.

### Behavior changes (Slice S — spec-aligned latent-bug fixes)
- `.noir/project.id` + `.noir/config.yml` → `skipIfExists` (predecessor `noir init` overwrote on every run — `project.id` overwrite orphaned the store DB named after it). Re-init now preserves both.
- `.noir/NOIR.md` → managed `BRIEF_BLOCK` markers (predecessor wrote the whole file with no markers). First-run output gains markers; user notes outside markers survive re-runs. A legacy pre-Slice-S unmarked `NOIR.md` is self-healed on the next `noir init`.
- `.noir/scaffold-version` (`noir-scaffold=1.0.0`) stamped on `noir init`/`create`.
- `noir sync` widened: re-emits `.mcp.json` (regenerate) + the NOIR.md brief (managed) + CLAUDE.md blocks + ignore files; no longer seeds `RULES.md` (init owns seeds).

### Deferred to a later beta (documented in `docs/roadmap.md` §v1.x backlog)
Embedding-model upgrade (`bge-small-en-v1.5` — needs a model-version stamp + re-index-on-change mechanism); S10 multi-host adapters; daemon detach/socket-activation/auth; full-screen TUI; in-process read-only store fallback; tree-sitter chunking; trigram tokenizer; full `.gitignore` parsing; graph/temporal KG; OS keychain; prompt caching; streaming (D5-forbidden); the `tsconfig.test.json` rollout to the remaining 9 packages; and the smaller S1/S5 micro-items.

---

## 1.0.0-beta.1 (2026-07-25)

**First npm publish.** All 10 `@noir-ai/*` packages (`core, store, workflow, skills, daemon, adapters, cli, context, model, memory`) published at the unified version `1.0.0-beta.1`, dist-tag **`beta`**, each tarball carrying SLSA **provenance**. Consumable via `npx @noir-ai/cli@beta init`. Cut from `develop`; `release.yml` derived `channel=beta` from the tag living on `develop`.

### Fixed — CI release flow
Five integration fixes that took the publish job from red to green (documented in `docs/releasing.md` §8 Troubleshooting so they don't recur):
- **pnpm version conflict** — `pnpm/action-setup`'s default didn't match the repo's `packageManager` pin; install the pinned pnpm explicitly (version from `packageManager`), not the action's default.
- **build-before-typecheck ordering** — build now precedes typecheck so generated `dist/` + `.d.ts` outputs exist when typecheck reads them.
- **`pnpm pack --pack-destination`** — pack writes `.tgz` files into one known directory the publish step can locate (was scattering them).
- **`npm publish "./<tgz>"` path** — publish targets the packed tarball path, not a directory or a bare `npm publish` (which would miss the workspace-range rewrite `pnpm pack` does).
- **vitest major-bump test re-verification** — the `^3` bump (see Security) is a major; full suite + assertions re-checked, test invocation not assumed unchanged.

### Security
- **`pnpm audit` 8 → 0**, cleared via `pnpm.overrides` (`sharp`, `hono`, `esbuild`, `vite`) and bumping `vitest` to `^3`. Transitive dedupe only; no source changes.

### Changed
- **`noir --version` / `noir --help` → stdout** (were stderr) — data on stdout, diagnostics on stderr, matching the S9 convention.
- **CI actions → v7/v6, Node 24** — `actions/checkout@v7`, `actions/setup-node@v7`, `pnpm/action-setup@v6` (clears the Node-20 deprecation annotation).

Beta targets early testers; promote to stable `1.0.0` once validated in a real project (merge `develop`→`main`, tag `v1.0.0` on `main` → CI publishes `--tag latest`).

---

## v1.0 — release-ready (2026-07-25)

**v1.0 ACCEPTANCE-COMPLETE.** **10 packages** `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`; **729/729 tests green** (was 142 at the skeleton); build / typecheck / lint green. All committed locally on `develop` (**not pushed**).

**What shipped (S6–S9 + the skeleton S0–S5):**
- **S6 Context** — embedded hybrid retrieval: local in-process MiniLM embeddings + BM25 ∪ kNN fused by Reciprocal Rank Fusion.
- **S8 Model** — thin single-shot model library (`anthropic` / `openai` / `openai-compatible`); first-class `null` degradation; agent loops impossible by construction (no `tools`/`stream` on the request).
- **S7 Memory** — cross-session memory layered on the store (no schema migration); explicit-save default + opt-in Claude Code hooks template; append-only consolidation gated on the `memory.consolidation.enabled` master switch (never a silent paid call).
- **S9 CLI/TUI** — commander command tree + `@clack/prompts` home; stable exit codes; `status` probe-only (works daemon-down); every capability reachable from one shell entry point.
- Plus **S0–S5**: walking skeleton (stdio + daemon Streamable HTTP), S1 stores (SQLite + FTS5 + sqlite-vec), S4 SDD workflow engine, S5 builtin skills + compiler (**31 skills** = 19 full + 12 stub).

**End-to-end dogfood — PASSED 14/14:** real local embeddings → `context_search` hits; memory save→recall; workflow start→advance; durability across daemon restart; bounded-model degrades to `null` with no key.

**Finalization cleanups applied:** zod consolidated to **v4**; root **README rewritten** for the v1.0 toolkit; dead code + unused deps removed; biome / mcp-config / content-hash / jsdoc / re-export nits fixed.

All MVP v1.0 acceptance criteria met. **Next: cut the v1.0 release (publish / tag).** Deferred items are consolidated in the **v1.x backlog** in `docs/roadmap.md` (S10 more hosts, S11 distribution/SDK, plus per-area debt lists — daemon, CLI/TUI, context, memory, model, toolchain).

---

## S9 — CLI/TUI home screen (2026-07-25)

**Release-ready. v1.0 FEATURE-COMPLETE (S6–S9 done).** 729/729 tests green (was 501); build / typecheck / lint green. All on branch `develop`, local (not pushed). NO new package — the existing `@noir-ai/cli` was overhauled (total stays 10 packages).

### Added
- **Commander Command tree** replacing the hand-rolled `parseArgs` dispatcher (behavior-preserving: `init` / `sync` / `mcp serve` / `daemon start|stop` / `doctor` unchanged; the Gate-1 stdio subprocess test still passes). `exitOverride` + `configureOutput` so the process never `exit()`s mid-test and help/errors go to stderr.
- **Global flags** `--json` / `--no-input` / `--quiet` / `--verbose` / `--cwd` parsed in any position.
- **Stable exit codes:** 0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled. **Data → stdout, diagnostics → stderr.** `isInteractive()` gates every prompt (no hangs in CI / pipes / scripts).
- **Interactive home:** bare `noir` → `@clack/prompts` menu when TTY; `status` (human) when non-interactive; `status --json` under `--json`.
- **Commands:** `status` (probe-only — works daemon-down), `context {search,index,status}`, `memory {recall,save,sessions,forget,consolidate}`, `skills {list,sync}`, `task {new,status,advance,next}`, `daemon {start,stop,status,restart}`, `doctor` (config / store / embedder / native-deps / provider-status via `resolveModelConfig` — NO live model call).
- **Store-touching commands are MCP clients to the daemon** (`ensureDaemonRunning` + `@modelcontextprotocol/client` over HTTP).
- **New daemon MCP tools** `workflow_start` + `workflow_advance` (gated `ctx.engine`) backing `task new` / `advance`.
- **New runtime deps:** commander, @clack/prompts, picocolors, cli-table3, ora, @modelcontextprotocol/client.

### Changed
- `status` is now **probe-only**: it reports daemon state honestly and NEVER auto-starts a daemon (works daemon-down: exit 0, `daemon:{running:false}`). Active commands (`context *`, `memory *`, `task *`) still start/require the daemon for v1.
- Bare `noir` in a non-interactive context now dispatches to `status` (was `printHelp`).
- `daemon --detach` is foreground-honest: it returns exit code 2 ("not implemented, tracked v1.x") rather than pretending to background.

### Fixed
- Opus final review (2 CRITICAL + 2 IMPORTANT — ALL FIXED + tested):
  - **C1 (silent daemon auto-start):** `status` no longer starts a daemon as a side effect of probing — it is read-only and reports daemon-down honestly.
  - **C2 (`--json` daemon-down envelope):** emits a single clean JSON envelope (was doubly-encoded — the error wrapper was itself JSON-stringified).
  - **I1 (`task new`/`advance` were permanent stubs):** now wired end-to-end via the new `workflow_start` / `workflow_advance` daemon MCP tools (gated `ctx.engine`).
  - **I2 (bare `noir` non-interactive):** runs `status` instead of `printHelp`, so scripts / pipes get a real machine-readable snapshot.

### Known v0 debt (deferred)
- Full-screen Ink/blessed TUI — v2 (S9 ships a `@clack/prompts` menu, not a full-screen TUI).
- Backgrounded daemon detach / socket-activation — v1.x (`daemon --detach` honestly returns exit 2 for v1).
- In-process read-only store fallback for `context *` / `memory *` / `task *` — daemon-required for v1; `status` is the only probe-only command.
- `task` id/slug distinction collapsed to slug for v1 (single namespace).

## S7 — Memory management (2026-07-25)

**Release-ready.** 501/501 tests green (was 340); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/memory`** (10th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`). Cross-session memory layered **ON TOP of the store — no schema migration.**
- **Observations** via `indexDoc({source:'memory'})` (FTS5) + `upsertVec({source:'memory'})` (sqlite-vec, 384-dim) + KV `memory:obs:<id>` (authoritative full row) + `memory:sessions` / `memory:index` rollups. Dev-flavored open-enum taxonomy: `pattern | preference | architecture | bug | workflow | fact | decision | lesson` (`lesson` reserved for consolidation output; unknown values accepted + stored).
- **`save` / `recall` / `search` / `sessions` / `forget` / `consolidate`.** Recall **reuses S6's hybrid retrieval**: store `searchFt` + `knn` scoped to `source:'memory'` → `fuseRrf` (Reciprocal Rank Fusion, k=60 — imported from `@noir-ai/context`) → cheap regex entity-boost (identifiers / paths, no LLM) → hydrate FULL content from KV (never truncated, blueprint §9 / DS-9). BM25-only degraded fallback when no embedder.
- **Daemon:** resolves the embedder ONCE and passes the same `EmbedFn` to both `ContextEngine` and `MemoryEngine`; new `packages/daemon/src/memory-seam.ts`. 5 MCP tools (`memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`) + conditional `memory_consolidate`, all gated on `ctx.memory` (mirrors `ctx.store` / `ctx.engine`).
- **Consolidation:** append-only, explicitly-invoked job consuming S8 `complete()`. Emits derived `type:'lesson'` with `provenance:[ids]`; originals never mutated or deleted (reversible + auditable).
- **Config:** new `memory:` block in `NoirConfigSchema` (`consolidation:{enabled, provider?, model?, types?}`); `resolveMemoryConfig` bridge (pure projection; no core→memory import cycle) wired through the daemon.
- **Capture:** explicit-save is the default; a host-neutral `CaptureEvent` type + an **OPT-IN** Claude Code hooks template (a doc/settings snippet the user installs; NEVER auto-wired, never silent).
- **2 new builtin skills** `noir-recall` + `noir-remember` (skills pack now 31 = 19 full + 12 stub).

### Changed
- Consolidation capability is gated on the user's `memory.consolidation.enabled` master switch (NOT on `model.defaultProvider`); `enabled:false` ⇒ `memory_consolidate` tool unregistered + `consolidate` refuses `{ok:false, reason:'no-provider'}` with no model call — regardless of other model config.
- The daemon constructs a single shared embedder for context + memory (was: context-only).

### Security
- Opus final review (1 CRITICAL — FIXED + tested; all other blueprint D6 hard rules clean). **CRITICAL:** consolidation was initially gated on `model.defaultProvider`, which left a path to a silent paid LLM call (blueprint §9 anti-pattern). Now gated on the explicit `memory.consolidation.enabled` master switch — `enabled:false` refuses with no model call before any provider resolution. Verified by a no-provider test asserting zero model invocation. Remaining D6 rules clean: in-process only, `ProjectId`-scoped (never a fs path), KV authoritative, never-truncated recall, single-flight, append-only consolidation, no sidecar / external server.

### Known v0 debt (deferred)
- Graph expansion / temporal knowledge graph (Zep / Graphiti-style entities + edges) — v1.x; needs an extraction LLM + graph storage.
- LLM auto-tagging (`concepts` / `type` on save) — v1.x; would be another silent LLM touch.
- Auto-capture-by-default — **opt-in hooks template only**; never auto-wired (DS-4 / DS-10).
- Auto-install of the Claude Code hooks template (today the user copies the snippet manually).
- Multi-user / org scoping (per-user memory namespaces) — v1.x; v1 is solo power-user.
- Remote sync / cloud memory — never default (violates D6 local+free); a remote *embedding* provider is already opt-in via S6.

## S8 — Bounded model layer (2026-07-25)

**Release-ready.** 340/340 tests green (was 247); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/model`** (9th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model}`). A thin single-shot model **library** — zero MCP tools; consumed in-process by S4 / S7 / S9.
- **`complete(req, cfg)` → `string | object | null`:** one function, 3 adapters (`anthropic` via `@anthropic-ai/sdk` Messages; `openai` via the openai SDK; `openai-compatible` via global `fetch` POST `${baseURL}/chat/completions`, covering Ollama / LM Studio / vLLM with zero extra dep). All adapters use dynamic `import()` + structural typing — import-isolated: a bundle that never selects an adapter ships zero SDK bytes.
- **Structured output:** prompt-based JSON + validate (Zod `.parse` or a caller-supplied function) + at most ONE repair retry (the only retry in the layer).
- **First-class `null` degradation:** no provider ⇒ `null`; missing key ⇒ `null` / `{ok:false}` BEFORE the SDK client is constructed. Full test suite runs offline/free.
- **`model:` config block** on `NoirConfigSchema` (`defaultProvider`, `tiers` draft/title/summarize/consolidate, `providers{name:{model, baseURL?, apiKeyEnv?}}`); `resolveModelConfig` bridge in `@noir-ai/model` (pure projection; no core→model import cycle; stores the env-var NAME, reads the value at call time).

### Changed
- Agent loops are impossible by construction: the `complete` request type has NO `tools` / `stream` parameter (compile-time-enforced).
- Provider resolution is EXPLICIT-only: resolved solely from `req.provider || cfg.defaultProvider`; NEVER inferred from env-var presence; no explicit configured provider ⇒ `null`. The Anthropic/OpenAI SDKs' own env-var fallback can therefore NEVER trigger a paid call.
- SDK `maxRetries: 0` everywhere; transport failures are not retried (the JSON-repair retry is the only retry).

### Security
- Opus final review (0 critical; all blueprint D5 hard rules clean; 2 IMPORTANT — all fixed + tested): (1) `openai-compatible` error `reason` no longer embeds the raw response body (was a prompt/key leak risk on echoing endpoints — NFR-4); (2) the OpenAI adapter now forwards `req.signal` + `maxRetries:0` (bounded wall-clock — NFR-3).

### Known v0 debt (deferred)
- Streaming; tool-calling / agent loops (forbidden by D5 design).
- OS keychain (secrets via env for now).
- Prompt caching (Anthropic `cache_control`).
- Provider-native JSON strict mode (OpenAI `response_format: strict` / Anthropic forced-tool).
- `onUsage` usage sink (fires on success; `noir doctor` wiring deferred).
- Consumer wiring — S4 artifact drafting, S7 consolidation, S9 home help wire `complete()` when consumed; S8 provides the library + config only.
- Real-SDK export-shape drift is unverifiable under offline (fixture-based) CI.

## S6 — Context management (2026-07-25)

**Release-ready.** 247/247 tests green (was 142); build / typecheck / lint green. All on branch `develop`, local (not pushed).

### Added
- **New package `@noir-ai/context`** (8th package — `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context}`). Embedded hybrid retrieval engine that fills S1's declared-but-unused `EmbedFn` seam.
- **Embeddings:** local in-process embedder via `@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2` (384-dim → zero `vec0` migration), loaded lazily through a dynamic import, L2-normalized; model cache at `~/.noir/models/`. Remote (OpenAI / Voyage / Cohere via Matryoshka-384) and Ollama embedders are opt-in and provider-explicit — never the default, never silent.
- **Indexer:** SHA-256 content-hash incremental tracking (on-demand by default; `--watch` opt-in). Markdown-heading chunker for docs; line/token-bounded (~512 tok / 64 overlap) chunker for code. Index-time identifier explosion for BM25 under the `porter` unicode61 tokenizer.
- **Hybrid retriever:** BM25 ∪ kNN fused by Reciprocal Rank Fusion (k=60, rank-based, no score normalization) → token-budget fill → FTS5 windowed snippets (never truncated). BM25-only degraded mode when an embedder is unavailable.
- **MCP tools:** `context_search`, `context_index`, `context_status`, gated on a new `ctx.context` ServerContext service (mirrors `ctx.store` / `ctx.engine`). New `context:` config block on `NoirConfigSchema`; new `packages/daemon/src/context-seam.ts`.
- **Builtin skill `noir-context`** (skills pack now 29 = 17 full + 12 stub).

### Changed
- `Store` interface + impl: added `deleteDoc` / `deleteVec`. New exported `vecAvailability()` native-binary probe centralizes the better-sqlite3 / sqlite-vec availability check (other packages' tests use it instead of importing those natives directly).

### Security
- Opus final review (0 critical, 3 IMPORTANT — all fixed + tested): (1) sensitive-file denylist (`.env`, `*.pem`, keys never indexed); (2) path confinement (rejects `..` / out-of-root traversal); (3) single-flight serialization of concurrent index calls (no orphaned vectors).

### Known v0 debt (deferred)
- Full `.gitignore` parsing (a denylist ships today).
- Tree-sitter symbol-aware code chunking (line/token chunking ships today).
- kNN-only-hit snippet hydration (currently an empty snippet, reported as `mode:'hybrid'`).
- `--watch` full daemon wiring.
- Remote embedding provider SDK completion (current stubs).
- First-run model download (~22 MB, one-time, cached) surfaces an unsupervised network fetch.
