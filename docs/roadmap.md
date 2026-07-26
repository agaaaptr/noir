# Noir — Roadmap & North Star

> **Living document.** This is the durable forward plan for the Noir AI toolkit. It exists so that **any future version of the project always knows where Noir is headed and why**. Update it as versions ship and the direction evolves.
>
- **Origin / detailed rationale:** `docs/specs/2026-07-23-noir-toolkit-design.md` (the full design blueprint + decision log).
- **Decisions of record:** `docs/decisions/` (ADR series, created at implementation).

---

## North Star

**Noir is the discipline, context, and memory layer that makes any AI CLI behave like a disciplined spec-driven engineer — and the foundation of the Noir AI ecosystem.**

- The **host CLI** is the execution engine (muscle).
- **Noir** is the workflow, context, and memory brain.
- **Bring your own agent.** Noir adapts to whichever agentic CLI the user already runs; it does not depend on any third-party plugin within its own flow.

The ecosystem goal: a portable, extensible toolkit that works across every major agentic CLI, with native memory/context, growing toward team and platform capabilities. v1 is deliberately small and sharp; the architecture is designed so the long-term vision is reachable **without rework**.

---

## Current status (living — update as slices ship)

> **As of 2026-07-26. v1.2.0-beta.2 PUBLISHED on npm (dist-tag `beta`); the global-install no-op is fixed + verified working.** The single source of "where Noir is right now." Update this whenever a slice ships or direction shifts — so no session loses the thread.

> **Un-released on `develop` (LOCAL, not pushed — 2026-07-26 session):** three sub-projects from the scaffold/TUI discovery — **SP-A** scaffold root-safety (the "noir init duplicates" bug is fixed) + already-init no-op + `noir doctor` nested-`.noir` detection; **SP-B** branded banner + host-aware home (banner · tagline · host-direction · command list); **SP-C** regenerate conflict resolution (`onConflict` hook + `@clack` menu + `--force`). All TDD; full repo green (1122 tests). CHANGELOG §Unreleased; specs in `docs/superpowers/specs/2026-07-26-*-design.md`. **Shipped (SP-D):** semantic dedup via S6 embeddings + `noir doctor --dedup` (the only thing that catches CLAUDE.md≈AGENTS.md overlap). **Still deferred:** content-hash dedup, three-way managed-block merge.

**Built & shipped (v1.0.0-beta.1 on npm, dist-tag `beta`):**
- **Walking skeleton** (slices **S0 + S2 + S3-minimal**) — the integration thesis is *proven*: a host (Claude Code) connects to Noir over MCP and `host_status` round-trips over **stdio** (Gate 1) and a **daemon-backed Streamable HTTP** transport with stdio FS-fallback (Gate 2).
- **S1 Stores** — `@noir-ai/store`: embedded `better-sqlite3` + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN), daemon-owned single writer, `ProjectId`-keyed DB at `.noir/store/<projectId>.db`, read-only FS-fallback, `store_status` MCP tool. Acceptance (persistence exists + queryable) MET; final review = release-ready.
- **S4 SDD Workflow Engine** — `@noir-ai/workflow`: hand-rolled FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with **observable, escapable gates** (§9.1 — every decision recorded; `--force` with reason; jump-to-phase), Full/Quick/Resume modes, cross-session resume, `.noir/` artifacts, `checkpoint` + `workflow_status` MCP tools. Acceptance (lifecycle runs end-to-end) MET; final review = release-ready.
- **S5 Builtin skills + compiler** — `@noir-ai/skills`: a copy+validate compiler over a shipped `builtin/` pack of **28 skills** (16 full playbooks + 12 valid stubs, 6 categories — SDD lifecycle 7, power 6, session 4, git 4, FE/BE/domain 4, utils 3), all `noir-` prefixed. `noir init` / `noir sync` emit the pack to `.claude/skills/` idempotently; `description` = WHEN is enforced in code (WHAT-descriptions rejected); enforcement is the S4 engine's observable gates, not skill-level rhetoric. Acceptance (pack emits + validates + installs end-to-end) MET; final review = release-ready.
- **S6 Context management** — `@noir-ai/context`: embedded hybrid retrieval engine that fills S1's declared-but-unused `EmbedFn` seam. Local in-process embedder (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim → zero `vec0` migration) loaded lazily via dynamic import, L2-normalized; remote (OpenAI/Voyage/Cohere via Matryoshka-384) + Ollama embedders are opt-in / provider-explicit (never default, never silent). SHA-256 content-hash incremental indexer (on-demand default, `--watch` opt-in); markdown-heading chunker for docs + ~512-tok/64-overlap for code. Hybrid retriever: BM25 ∪ kNN → Reciprocal Rank Fusion (k=60, rank-based) → token-budget fill → FTS5 windowed snippets (never truncated); BM25-only degraded mode when no embedder. Three MCP tools (`context_search` / `context_index` / `context_status`) on a new `ctx.context` ServerContext service; sensitive-file denylist + path confinement + single-flight serialization. New `noir-context` builtin skill (pack at S6: 29 = 17 full + 12 stub). **Milestone: the host agent stays focused — it queries a small ranked snippet set instead of re-reading whole files into its context window.** Acceptance MET; final review = release-ready.
- **S8 Bounded model layer** — `@noir-ai/model`: a thin single-shot model **library** (NOT a tool surface — zero MCP tools). One `complete(req, cfg)` function backed by 3 adapters (`anthropic` via `@anthropic-ai/sdk` Messages, `openai` via the openai SDK, `openai-compatible` via global `fetch` → `${baseURL}/chat/completions` for Ollama/LM Studio/vLLM), all dynamically `import()`-ed + structurally typed (import-isolation: a bundle that never selects an adapter ships zero SDK bytes). Agent loops impossible by construction — NO `tools`/`stream` params exist on the request. Provider-EXPLICIT only: provider resolved solely from `req.provider || cfg.defaultProvider`; NEVER inferred from env-var presence; no explicit configured provider ⇒ `null`. Missing key ⇒ `null`/`{ok:false}` BEFORE the SDK client is constructed, so the Anthropic/OpenAI SDKs' own env-var fallback can NEVER trigger a paid call. Structured output = prompt-JSON + validate (Zod `.parse` or a function) + at most ONE repair retry (the only retry in the layer; SDK `maxRetries:0` everywhere; transport failures not retried). New `model:` block in `NoirConfigSchema` (`defaultProvider`, `tiers` draft/title/summarize/consolidate, `providers{name:{model, baseURL?, apiKeyEnv?}}`); `resolveModelConfig` bridge in `@noir-ai/model` (pure projection; core→model no import cycle; stores the env-var NAME, reads value at call time). null-degradation is FIRST-CLASS: `null` (no provider/key) propagates through the structured path, distinct from `{ok:false}` (attempted-call failure); full test suite runs offline/free. Consumers (later slices): S7 consolidation + S4 artifact drafting + S9 home help call `complete()`. **Milestone: automated drafting — spec/plan/intake scaffolds and memory consolidation become machine-assistable while staying bounded and never silent.** Acceptance MET; final review = release-ready.
- **S7 Memory management** — `@noir-ai/memory`: cross-session memory layered **ON TOP of the store (NO schema migration)** — observations via `indexDoc({source:'memory'})` + `upsertVec({source:'memory'})` + KV `memory:obs:<id>` (authoritative row) + `memory:sessions` + `memory:index`. Dev-flavored open-enum taxonomy (`pattern|preference|architecture|bug|workflow|fact|decision|lesson`; `lesson` reserved for consolidation output). `save` / `recall` / `search` / `sessions` / `forget` / `consolidate`. Recall **reuses S6's hybrid retrieval**: store `searchFt` + `knn` (source:'memory') → `fuseRrf` (imported from `@noir-ai/context`) → cheap regex entity-boost → hydrate FULL content from KV (never truncated); BM25-only degraded fallback when no embedder. Consolidation is append-only, explicitly-invoked, and provider-gated via S8 `complete()` — emits derived `type:'lesson'` with `provenance:[ids]`, originals unchanged. **CRITICAL post-review fix:** consolidation capability is gated on the user's `memory.consolidation.enabled` master switch (NOT on `model.defaultProvider`); `enabled:false` ⇒ tool unregistered + `consolidate` refuses `'no-provider'` with **no model call** — closes the blueprint §9 "silent paid consolidation" anti-pattern; the `resolveMemoryConfig` bridge is wired through the daemon. Daemon resolves the embedder ONCE and passes the same `EmbedFn` to both `ContextEngine` and `MemoryEngine`; new `memory-seam.ts`. 5 MCP tools (`memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`) + conditional `memory_consolidate`, gated on `ctx.memory`. Explicit-save is the default capture mode; a host-neutral `CaptureEvent` type + an **OPT-IN** Claude Code hooks template (a settings snippet the user installs — NEVER auto-wired, never silent). 2 new builtin skills `noir-recall` + `noir-remember` (pack now 31 = 19 full + 12 stub). **Milestone: cross-session memory — a user saves an insight in one session and recalls it (hybrid BM25+vec+RRF) in another; forget works; consolidation refuses cleanly without a provider.** Acceptance MET; final review = release-ready.
- **S9 CLI/TUI home screen** — `@noir-ai/cli` overhauled (NO new package — extends the existing CLI; total stays 10 packages). Migrated the hand-rolled `parseArgs` dispatcher → **commander** Command tree (behavior-preserving: init / sync / mcp serve / daemon start|stop / doctor unchanged; the gate1-stdio subprocess test still passes) with `exitOverride` + `configureOutput` (never `process.exit` mid-test; help+errors → stderr). Global flags `--json` / `--no-input` / `--quiet` / `--verbose` / `--cwd` (parse in any position); stable exit codes (0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled); **data → stdout, diagnostics → stderr**; `isInteractive()` gates every prompt (no hangs in CI / pipes / scripts). Home: bare `noir` → `@clack/prompts` menu when TTY, `status` (human) when non-interactive, `status --json` under `--json`. Commands: `status` (probe-only — works daemon-down, NEVER auto-starts), `context {search,index,status}`, `memory {recall,save,sessions,forget,consolidate}`, `skills {list,sync}`, `task {new,status,advance,next}`, `daemon {start,stop,status,restart}` (foreground-honest; `--detach` → exit 2), `doctor` (config / store / embedder / native-deps / provider-status via `resolveModelConfig` — NO live model call). Store-touching commands are MCP clients to the daemon (`ensureDaemonRunning` + `@modelcontextprotocol/client` over HTTP); new daemon MCP tools `workflow_start` + `workflow_advance` (gated `ctx.engine`) back `task new` / `advance`. New runtime deps: commander, @clack/prompts, picocolors, cli-table3, ora, @modelcontextprotocol/client. **Milestone: the integrative capstone — every S1/S4/S6/S7/S8 capability is now reachable from one shell entry point, scriptable OR interactive, daemon-down-honest.** Acceptance MET; final review = release-ready.
- 10 packages `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`; MCP TS SDK **v2 beta (`2.0.0-beta.5`)**; toolchain pnpm/tsup/vitest/Biome/TS-ESM; CI (ubuntu+macos, node 24); MIT.
- **729/729 tests green** (was 501); all acceptance gates verified; final whole-branch reviews = release-ready.
- **Native skills only** — the predecessor `noir-workflow` Claude Code plugin + marketplace (the repo's origin) have been removed; Noir now ships its 31 `noir-` builtins via `noir init`/`sync` with no plugin or marketplace anywhere (see ADR-0002).

**Release sequence so far:**
- **v1.0.0-beta.1 PUBLISHED on npm** (2026-07-25) — all 10 `@noir-ai/*` packages, dist-tag `beta` + SLSA provenance, consumable via `npx @noir-ai/cli@beta init`. Release setup DONE: scoped `@noir-ai/*`, unified versioning, Path A (granular npm token + provenance) CI on git tag, branch-based beta/stable channel (`release.yml` derives the dist-tag from which branch holds the tag). **729/729 tests**; end-to-end dogfood passed 14/14; all MVP v1.0 acceptance criteria met.
- **v1.1.0-beta.1** added the six v1.x capability slices (K/R/I/P/S/X) + the consolidated debt batch (966 tests; supersedes 1.0.0-beta.1 on the `beta` dist-tag).
- **v1.2.0-beta.1** added multi-host (S10) + the SDK/doctor remainder (S11) — see below (1089 tests; supersedes 1.1.0-beta.1).
- **NEXT = validate the beta in a real project per host**, then promote to stable `1.x`: merge `develop`→`main`, `node scripts/bump-version.mjs <ver>`, tag `v1.x` on `main` → CI derives `channel=stable` and publishes `--tag latest` (so `npm i @noir-ai/cli` resolves to the stable version).

**v1.x capability slices (designed 2026-07-25; shipped in 1.1.0-beta.1):**
Design: `docs/specs/2026-07-25-v1x-capabilities-design.md`. Five capabilities extend one keystone refactor. **6/6 done; shipped in 1.1.0-beta.1** (966 tests at that release; superseded by 1.2.0-beta.1 on the `beta` dist-tag):
- **K** Keystone — `managedBlock` factory + shared `blockWriter` (`writeManagedRegion` etc.) + `HostAdapter.emitRules` seam (pure refactor; no behavior change).
- **R** Rules — `.noir/rules/RULES.md` Noir-curated seed + wired into `CLAUDE.md` via `RULES_BLOCK` + `noir-rules` skill.
- **I** Ignore — `IgnoreManager` + `syncIgnores` into init/sync (managed-block idempotent; `.gitignore`/`.dockerignore`/`.npmignore`/`.prettierignore`).
- **P** PRD — `prd` artifact kind + `writePrd`/`readPrd` + `noir-prd` skill (no FSM change; explicit opt-in).
- **S** Scaffold — new `@noir-ai/create` engine (three-mode writer `regenerate`/`managedBlock`/`skipIfExists` generalizing keystone-K `blockWriter`; declarative manifest; hand-rolled `{{var}}` templates; `.noir/scaffold-version`; migrations registry w/ inline-conflict CI-safe path; read-only stack-detect) + `noir init`/`sync` refactored to consume it + **new `noir create [dir]`** (AI-layer only) + `noir init --upgrade` (migrations) + `noir doctor` scaffold-version drift. Opus-reviewed + gate bugs fixed (project.id heal, CLAUDE.md idempotency, legacy NOIR.md self-heal). Behavior changes: `project.id`/`config.yml` → skipIfExists; `NOIR.md` → managed `BRIEF_BLOCK`; `sync` widened (re-emits `.mcp.json` + NOIR.md brief, no longer seeds RULES.md).
- **X** Integration — first-class integration layer (skill-only default + gated-write-proxy tier + full-runtime tier). First integration = **ClickUp**: shipped `noir-clickup` skill (`SKILL.md` 5-flow playbook + real `references/clickup-api.md`) + `integration.json` (`runtime:'gated-write-proxy'`, `tokenEnv:'CLICKUP_API_TOKEN'`). `discoverIntegrations()` + `integration.json` Zod schema (the deferred **K3**); `discoverAll()` emits builtins+integrations (pack now 34). Daemon `integrations_auth` MCP tool (resolves `CLICKUP_API_TOKEN` server-side at call time — kills the non-interactive-shell gotcha) + `noir.clickup_write` gated-write-proxy (HARD confirm gate dry-run→confirm→POST; allowlisted endpoints only; id-charset validation; 429 `X-RateLimit-Reset` backoff; audit JSONL to `.noir/audit/`). Core `integrations` config block (`runtime` downgrade honored); adapter `emitMcpConfig(ctx,opts,integration?)` overload. **Live-verified**: token resolves, `GET /user`→HTTP 200. Opus security-reviewed (no CRITICAL; I1 assignees-plural + I2 runtime-gate + minors fixed).
**All 6 v1.x capability slices (K/R/I/P/S/X) shipped in 1.1.0-beta.1.** Specs: `docs/superpowers/specs/2026-07-25-slice-{s-scaffold,x-integration}-design.md`. **Next-session playbook + full technical debt: `docs/v1x-next-session.md`.**

**v1.2.0-beta.1 — S10 multi-host + S11 remainder (DONE on `develop`; 1089/1089 tests green).** Noir is now cross-CLI. A `resolveAdapter(host)` registry over the `HostId` enum (`claude` | `agents-md` | `gemini` | `cursor` | `opencode`) drives per-host emission via `--host` on `noir init`/`create`/`sync`. `claude` stays the default — a bare `noir init` is byte-identical to pre-multi-host (regression anchor, existing tests stay green). A shared `emitAgentsMd(ctx)` helper writes the byte-identical universal `AGENTS.md` (the 32-platform standard) for every host; hosts with a native context file (`claude`→`CLAUDE.md`, `gemini`→`GEMINI.md`) keep it primary and **do not duplicate** into `AGENTS.md`. Cursor skills compile to flat `.cursor/rules/<name>.mdc`; opencode emits `opencode.json` with a distinct `type`-tagged MCP shape (verified against opencode.ai docs). S11 remainder: `docs/sdk.md` (the per-package framework/library API) + a `noir doctor` `publish` check (advisory package-metadata validation). Locked decisions in [ADR-0004](decisions/0004-multi-host-adapters.md); spec [`superpowers/specs/2026-07-25-s10-multihost-design.md`](superpowers/specs/2026-07-25-s10-multihost-design.md). **Deferred:** `qwen` and `agy` adapters (the universal `AGENTS.md` covers them in the meantime).

> Note: `develop` is at **1089 tests** (K/R/I/P/S/X + the v1.x debt batch + S10 multi-host + the S11 remainder; lint→0); `main`/npm `latest` stays at 1.0.0-beta.1 until merged.

**v1.0 finalization — COMPLETE:**
- Finalization audits (code, docs, quality) run + fixes applied: zod consolidated to **v4**, root **README rewritten** for the v1.0 toolkit, dead code + unused deps removed, biome/mcp/hash/jsdoc/re-export nits fixed. End-to-end dogfood PASSED 14/14 (real local embeddings → `context_search` hits; memory save→recall; workflow start→advance; durability across daemon restart; bounded-model degrades to `null` with no key). Cross-CLI hosts (S10) and the SDK/doctor remainder (S11) have since shipped in 1.2.0-beta.1 — see below.

**Known v0 debt** is now consolidated in the **"v1.x backlog"** section below (S10 hosts, S11 distribution, daemon detach/auth, full-screen TUI, in-process read-only fallback, tree-sitter chunking, OS keychain, prompt caching, streaming, god-file refactors, and more).

**Goal (North Star, unchanged):** Noir = the discipline/context/memory layer that makes any agentic CLI behave like a disciplined spec-driven engineer. v1 MVP = a solo power-user doing idea→spec→plan→implement inside Claude Code with persistent cross-session memory.

---

## v1.x backlog (consolidated)

All deferred items, grouped by area. Each was intentionally out of v1 to keep scope sharp; none are abandoned. S10/S11 begin the v1.x line after the v1.0 cut. (The high-level "why deferred" view stays in the **Deferred Features** table further down; this is the detailed engineering list.)

> **Resolved in v1.1.0-beta.1 (2026-07-25):** **K3** (skills-compiler generalization → landed in Slice X as `discoverIntegrations` + `integration.json` schema); **R4/R5** (`rules:` config block + `noir doctor` RULES.md budget check); **P3/P4** (`@noir-ai/model` `draftPrd` + `prd:` config + `advance()` soft PRD gate); **Workflow** dual-source-of-truth collapse (W1) + vestigial checkpoint wired to audit export (W2) + S4 nits (W3); **Context** kNN-only-hit snippet hydration (C1); **Toolchain** stale-skill-dir cleanup on sync (T2) + `tsconfig.test.json` pilot on `@noir-ai/cli` (T1 — remaining 9 packages still `src`-only, follow-up); plus the 10 pre-existing lint warnings → 0. See `docs/CHANGELOG.md` §1.1.0-beta.1.

### S10 — More host adapters

> **Resolved in v1.2.0-beta.1 (2026-07-26):** the adapter registry (`resolveAdapter(host)`), the `HostId` enum (`claude`/`agents-md`/`gemini`/`cursor`/`opencode`), the widened `host:` config + `CompileTarget`, the `--host` flag on `noir init`/`create`/`sync`, and 4 new adapters (`agents-md`/`gemini`/`cursor`/`opencode`). AGENTS.md is the universal emitter; cursor skills compile to flat `.mdc`; opencode carries a distinct MCP shape. See `docs/CHANGELOG.md` §1.2.0-beta.1 + [ADR-0004](decisions/0004-multi-host-adapters.md).

**Still deferred (later beta):**
- Emitters for **qwen / agy** — the universal `AGENTS.md` covers them in the meantime; their native adapters land later.
- Multi-host emit (`hosts:[...]` → emit for several hosts at once). v1.x is **single-host select**: `host:` picks ONE primary host (+ always-`AGENTS.md`); per-host `CompileTarget` widens automatically.

### S11 — Distribution + SDK
- **Distribution DONE + LIVE:** branch-based beta/stable release flow (`release.yml`, npm automation token + provenance), `scripts/install.sh` native installer, npm publish metadata on all 10 packages, release CI, and `docs/installation.md` + `docs/releasing.md`. **v1.0.0-beta.1 shipped 2026-07-25** (all 10 `@noir-ai/*`, dist-tag `beta`); stable `1.0.0` follows once the beta is validated in a real project.
- **SDK / doctor remainder — DONE in v1.2.0-beta.1:** [`docs/sdk.md`](sdk.md) (the per-package framework/library API surface — "usable as a framework") + a `noir doctor` `publish` check (advisory package-metadata validation across all `packages/*`: name, version, non-empty `files`, and `bin` for the cli). **S11 is now fully resolved.** (Distribution is npm-native; there is no plugin marketplace to publish to.)

### Daemon
- backgrounded/detached mode + socket-activation (`daemon --detach` honestly returns exit 2 today).
- auth token for the daemon transport (none today).
- per-project `daemon.json` (today a single global `~/.noir/daemon.json` clobbers under concurrent projects).

### CLI / TUI
- full-screen Ink/blessed TUI (v2 — S9 ships a `@clack/prompts` menu only).
- in-process read-only store fallback for `context` / `memory` / `task` commands (daemon-required for v1; `status` is the only probe-only command today).
- `task` id/slug distinction (collapsed to a single slug namespace for v1).

### Workflow
- S4 dual source of truth: `task.history` (inside TaskState) duplicates `audit:<id>` KV (`GateResult[]`); collapse to one authoritative record.
- S4 checkpoint save/restore is vestigial (data is written but nothing consumes it on resume) — wire it into resume or remove it.

### Context
- tree-sitter symbol-aware code chunking (line/token-bounded chunking ships today).
- full `.gitignore` parsing (a static denylist ships today).
- `trigram` tokenizer for FTS5 (`porter unicode61` today; splits camelCase poorly).
- kNN-only-hit snippet hydration (currently an empty snippet, reported as `mode:'hybrid'`).
- `--watch` full daemon wiring.
- remote embedding provider SDK completion (current stubs).
- embedding model upgrade (`bge-small-en-v1.5`, same 384-dim).

### Memory
- graph / temporal-KG expansion (Zep/Graphiti-style entities + edges; needs an extraction LLM + graph storage).
- LLM auto-tagging (`concepts` / `type` on save).
- auto-capture-by-default (an opt-in Claude Code hooks template ships today; never auto-wired).
- multi-user / org scoping (per-user memory namespaces; v1 is solo power-user).

### Model
- OS keychain for secrets (env vars today).
- prompt caching (Anthropic `cache_control`).
- provider-native JSON strict mode (OpenAI `response_format: strict` / Anthropic forced-tool).
- `onUsage` usage sink (fires on success; `noir doctor` wiring deferred).
- streaming (single-shot by design today; agent loops forbidden by D5).

### Toolchain / quality
- `tsconfig.test.json` (test/ files are not statically typechecked today).
- `references/` skill code-path coverage (only synthetic fixtures today; 0 shipped skills use it).
- engine-naming consistency (`ContextEngine` / `MemoryEngineImpl`).
- `indexer.ts` + `daemon/server.ts` god-file refactors.
- stale-skill-dir cleanup on `noir sync` (the managed `noir-*` namespace is overwritten idempotently, but removed/renamed builtin skills aren't pruned from `.claude/skills/` today).
- `biome.json` schema deprecation infos (drift between biome's config schema and the pinned version).
- first-run model download UX (one-time ~22 MB fetch, cached in `~/.noir/models/`).

### v1.x capabilities (K/R/I/P/S/X) — deferred sub-items (2026-07-25)
- **K3:** skills-compiler generalization — deferred to slice X (`discoverIntegrations` + integration.json schema).
- **R4/R5:** config `rules:` block (`{enabled, lengthBudgetKb}`); `noir doctor` RULES.md budget check (≤6 KB).
- **P3/P4:** `@noir-ai/model` `draftPrd(intake, clarify, memory)` (offline → template); config `prd:` block + `advance()` soft PRD gate predicate (feature/epic entering spec with no PRD → remind; escapable).
- **Lint:** 10 `noCommaOperator`/`noNonNullAssertion` warnings remain in `cli/test/*` (pre-existing v1.0-beta, non-auto-fixable, cosmetic, not in CI). ⚠️ `pnpm lint` was RED on the develop baseline before this session (pre-existing `useOptionalChain`/`useLiteralKeys`); now GREEN via `biome --write --unsafe` (committed).
- **X verify-live (runtime, not blockers):** ClickUp `GET /list/{id}` `statuses` field; tag auto-create vs 400 (ClickApp-dependent).

---

## Version Targets

### v0.x — Foundation & Walking Skeleton  *(pre-release)*
**Slices S0–S2.** Monorepo, branding, `.noir/` store, SQLite/FTS5 stores, auto-managed daemon + Noir MCP server (stdio + HTTP).
- **Milestone:** a host CLI connects to Noir over MCP and a tool round-trips. The core integration thesis is proven end-to-end before any subsystem is deepened.

### v1.0 — Sharp Solo Experience  *(first public release)*
**Slices S3–S9.** Claude Code adapter + scaffolder, SDD workflow engine, builtin skills + compiler, context management, memory management, bounded model layer (optional), polished-but-minimal TUI home screen.
- **Target user:** a solo power-user doing idea → spec → plan → implementation inside **Claude Code**, with persistent cross-session memory.
- **Host scope:** **Claude Code only** (behind an abstract `HostAdapter` so generalization is later mechanical, not architectural).

### v1.x — Cross-CLI & Distribution
**Slices S10–S11.** Additional host adapters (OpenCode, Gemini, Agy, Qwen) with per-host emulation; npm publish (`@noir-ai/*`); `noir doctor`; framework docs; SDK surface ("usable as a framework").
- **Milestone:** true cross-CLI + installable product.

### v2.0 — Ecosystem  *(long-term)*
- Cloud sync for memory (opt-in).
- Team / multi-user features: shared specs, plans, and memory across a team.
- First-class Noir-native skill registry/distribution.
- Full theming + plugin SDK.
- Programmatic headless driving of host CLIs (multi-step orchestration from the TUI).
- Possibly a hosted/managed offering.

---

## Deferred Features (explicit — not abandoned)

These are intentionally **out of v1** to keep scope sharp. Each has a target version so it is never silently lost:

| Feature | Target | Why deferred |
|---|---|---|
| Hosts beyond Claude Code | v1.x | Nail one host fully first; abstract adapter keeps it cheap. |
| Memory cloud sync | v2.0 | v1 is solo/local; sync adds auth + infra. |
| Team / multi-user | v2.0 | Requires shared stores, identity, permissions. |
| First-class Noir-native skill registry/distribution | v2.0 | v1 ships its native builtins via `noir init`/`sync` with no install step. |
| Programmatic host-driving (`claude -p`, etc.) | v2.0 | v1 hands tasks off; full automation is later. |
| Full theming + plugin SDK | v1.x / v2.0 | Polish/en extensibility after core is solid. |

---

## Guiding Principles (durable)

1. **One CLI-agnostic core; hosts are thin targets.**
2. **`.noir/` is the single source of truth** — generated artifacts are pointers/transforms, never drifting copies.
3. **Daemon is the runtime authority**; TUI and hosts are clients.
4. **MCP = dynamic intelligence; static artifacts = declarative context/permissions/commands.**
5. **Graceful degradation everywhere** — no key → pure orchestration; daemon down → direct store; host lacks feature → emulate.
6. **YAGNI ruthlessly per version** — defer features deliberately (table above), never silently.

---

## How to use this roadmap

- **When shipping a version:** move the shipped items to a "Shipped" section (or release notes), advance the version target.
- **When direction changes:** update the North Star + Version Targets here, and record the *why* as an ADR in `docs/decisions/`.
- **When tempted to add scope:** check the Deferred table — if it is listed, it is intentional; add new deferrals here rather than dropping them silently.
