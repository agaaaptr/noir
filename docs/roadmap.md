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

> **As of 2026-07-25.** The single source of "where Noir is right now, what's built, and what's still missing." Update this whenever a slice ships or direction shifts — so no session loses the thread.

**Built & releasable (on `develop`, local — not pushed):**
- **Walking skeleton** (slices **S0 + S2 + S3-minimal**) — the integration thesis is *proven*: a host (Claude Code) connects to Noir over MCP and `host_status` round-trips over **stdio** (Gate 1) and a **daemon-backed Streamable HTTP** transport with stdio FS-fallback (Gate 2).
- **S1 Stores** — `@noir-ai/store`: embedded `better-sqlite3` + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN), daemon-owned single writer, `ProjectId`-keyed DB at `.noir/store/<projectId>.db`, read-only FS-fallback, `store_status` MCP tool. Acceptance (persistence exists + queryable) MET; final review = release-ready.
- **S4 SDD Workflow Engine** — `@noir-ai/workflow`: hand-rolled FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with **observable, escapable gates** (§9.1 — every decision recorded; `--force` with reason; jump-to-phase), Full/Quick/Resume modes, cross-session resume, `.noir/` artifacts, `checkpoint` + `workflow_status` MCP tools. Acceptance (lifecycle runs end-to-end) MET; final review = release-ready.
- **S5 Builtin skills + compiler** — `@noir-ai/skills`: a copy+validate compiler over a shipped `builtin/` pack of **28 skills** (16 full playbooks + 12 valid stubs, 6 categories — SDD lifecycle 7, power 6, session 4, git 4, FE/BE/domain 4, utils 3), all `noir-` prefixed. `noir init` / `noir sync` emit the pack to `.claude/skills/` idempotently; `description` = WHEN is enforced in code (WHAT-descriptions rejected); enforcement is the S4 engine's observable gates, not skill-level rhetoric. Acceptance (pack emits + validates + installs end-to-end) MET; final review = release-ready.
- **S6 Context management** — `@noir-ai/context`: embedded hybrid retrieval engine that fills S1's declared-but-unused `EmbedFn` seam. Local in-process embedder (`@huggingface/transformers` + `Xenova/all-MiniLM-L6-v2`, 384-dim → zero `vec0` migration) loaded lazily via dynamic import, L2-normalized; remote (OpenAI/Voyage/Cohere via Matryoshka-384) + Ollama embedders are opt-in / provider-explicit (never default, never silent). SHA-256 content-hash incremental indexer (on-demand default, `--watch` opt-in); markdown-heading chunker for docs + ~512-tok/64-overlap for code. Hybrid retriever: BM25 ∪ kNN → Reciprocal Rank Fusion (k=60, rank-based) → token-budget fill → FTS5 windowed snippets (never truncated); BM25-only degraded mode when no embedder. Three MCP tools (`context_search` / `context_index` / `context_status`) on a new `ctx.context` ServerContext service; sensitive-file denylist + path confinement + single-flight serialization. New `noir-context` builtin skill (pack at S6: 29 = 17 full + 12 stub). **Milestone: the host agent stays focused — it queries a small ranked snippet set instead of re-reading whole files into its context window.** Acceptance MET; final review = release-ready.
- **S8 Bounded model layer** — `@noir-ai/model`: a thin single-shot model **library** (NOT a tool surface — zero MCP tools). One `complete(req, cfg)` function backed by 3 adapters (`anthropic` via `@anthropic-ai/sdk` Messages, `openai` via the openai SDK, `openai-compatible` via global `fetch` → `${baseURL}/chat/completions` for Ollama/LM Studio/vLLM), all dynamically `import()`-ed + structurally typed (import-isolation: a bundle that never selects an adapter ships zero SDK bytes). Agent loops impossible by construction — NO `tools`/`stream` params exist on the request. Provider-EXPLICIT only: provider resolved solely from `req.provider || cfg.defaultProvider`; NEVER inferred from env-var presence; no explicit configured provider ⇒ `null`. Missing key ⇒ `null`/`{ok:false}` BEFORE the SDK client is constructed, so the Anthropic/OpenAI SDKs' own env-var fallback can NEVER trigger a paid call. Structured output = prompt-JSON + validate (Zod `.parse` or a function) + at most ONE repair retry (the only retry in the layer; SDK `maxRetries:0` everywhere; transport failures not retried). New `model:` block in `NoirConfigSchema` (`defaultProvider`, `tiers` draft/title/summarize/consolidate, `providers{name:{model, baseURL?, apiKeyEnv?}}`); `resolveModelConfig` bridge in `@noir-ai/model` (pure projection; core→model no import cycle; stores the env-var NAME, reads value at call time). null-degradation is FIRST-CLASS: `null` (no provider/key) propagates through the structured path, distinct from `{ok:false}` (attempted-call failure); full test suite runs offline/free. Consumers (later slices): S7 consolidation + S4 artifact drafting + S9 home help call `complete()`. **Milestone: automated drafting — spec/plan/intake scaffolds and memory consolidation become machine-assistable while staying bounded and never silent.** Acceptance MET; final review = release-ready.
- **S7 Memory management** — `@noir-ai/memory`: cross-session memory layered **ON TOP of the store (NO schema migration)** — observations via `indexDoc({source:'memory'})` + `upsertVec({source:'memory'})` + KV `memory:obs:<id>` (authoritative row) + `memory:sessions` + `memory:index`. Dev-flavored open-enum taxonomy (`pattern|preference|architecture|bug|workflow|fact|decision|lesson`; `lesson` reserved for consolidation output). `save` / `recall` / `search` / `sessions` / `forget` / `consolidate`. Recall **reuses S6's hybrid retrieval**: store `searchFt` + `knn` (source:'memory') → `fuseRrf` (imported from `@noir-ai/context`) → cheap regex entity-boost → hydrate FULL content from KV (never truncated); BM25-only degraded fallback when no embedder. Consolidation is append-only, explicitly-invoked, and provider-gated via S8 `complete()` — emits derived `type:'lesson'` with `provenance:[ids]`, originals unchanged. **CRITICAL post-review fix:** consolidation capability is gated on the user's `memory.consolidation.enabled` master switch (NOT on `model.defaultProvider`); `enabled:false` ⇒ tool unregistered + `consolidate` refuses `'no-provider'` with **no model call** — closes the blueprint §9 "silent paid consolidation" anti-pattern; the `resolveMemoryConfig` bridge is wired through the daemon. Daemon resolves the embedder ONCE and passes the same `EmbedFn` to both `ContextEngine` and `MemoryEngine`; new `memory-seam.ts`. 5 MCP tools (`memory_save` / `memory_recall` / `memory_search` / `memory_sessions` / `memory_forget`) + conditional `memory_consolidate`, gated on `ctx.memory`. Explicit-save is the default capture mode; a host-neutral `CaptureEvent` type + an **OPT-IN** Claude Code hooks template (a settings snippet the user installs — NEVER auto-wired, never silent). 2 new builtin skills `noir-recall` + `noir-remember` (pack now 31 = 19 full + 12 stub). **Milestone: cross-session memory — a user saves an insight in one session and recalls it (hybrid BM25+vec+RRF) in another; forget works; consolidation refuses cleanly without a provider.** Acceptance MET; final review = release-ready.
- **S9 CLI/TUI home screen** — `@noir-ai/cli` overhauled (NO new package — extends the existing CLI; total stays 10 packages). Migrated the hand-rolled `parseArgs` dispatcher → **commander** Command tree (behavior-preserving: init / sync / mcp serve / daemon start|stop / doctor unchanged; the gate1-stdio subprocess test still passes) with `exitOverride` + `configureOutput` (never `process.exit` mid-test; help+errors → stderr). Global flags `--json` / `--no-input` / `--quiet` / `--verbose` / `--cwd` (parse in any position); stable exit codes (0 ok · 1 error · 2 usage · 3 not-found · 4 daemon-down · 5 cancelled); **data → stdout, diagnostics → stderr**; `isInteractive()` gates every prompt (no hangs in CI / pipes / scripts). Home: bare `noir` → `@clack/prompts` menu when TTY, `status` (human) when non-interactive, `status --json` under `--json`. Commands: `status` (probe-only — works daemon-down, NEVER auto-starts), `context {search,index,status}`, `memory {recall,save,sessions,forget,consolidate}`, `skills {list,sync}`, `task {new,status,advance,next}`, `daemon {start,stop,status,restart}` (foreground-honest; `--detach` → exit 2), `doctor` (config / store / embedder / native-deps / provider-status via `resolveModelConfig` — NO live model call). Store-touching commands are MCP clients to the daemon (`ensureDaemonRunning` + `@modelcontextprotocol/client` over HTTP); new daemon MCP tools `workflow_start` + `workflow_advance` (gated `ctx.engine`) back `task new` / `advance`. New runtime deps: commander, @clack/prompts, picocolors, cli-table3, ora, @modelcontextprotocol/client. **Milestone: the integrative capstone — every S1/S4/S6/S7/S8 capability is now reachable from one shell entry point, scriptable OR interactive, daemon-down-honest.** Acceptance MET; final review = release-ready.
- 10 packages `@noir-ai/{core,store,workflow,skills,daemon,adapters,cli,context,model,memory}`; MCP TS SDK **v2 beta (`2.0.0-beta.5`)**; toolchain pnpm/tsup/vitest/Biome/TS-ESM; CI (ubuntu+macos, node 22); MIT.
- **729/729 tests green** (was 501); all acceptance gates verified; final whole-branch reviews = release-ready.
- Legacy plugin rebranded: marketplace `noir`, plugin `noir-workflow`.

**Next:**
- **v1.0 is FEATURE-COMPLETE (S6–S9 done).** No new features remain. NEXT is **MVP v1.0 finalization**: full codebase / doc / quality audits, project cleanup, and end-to-end dogfood — then cut v1.0.
- **Then:** S10 (cross-CLI hosts) / S11 (distribution + SDK) begin **v1.x**.

**Still missing for v1.0 (the MVP target) — finalization, not features:**
- Full whole-project audits (code, docs, quality) + E2E dogfood run before the v1.0 cut. Cross-CLI hosts (S10) and distribution/SDK (S11) remain v1.x.

**Known v0 debt (documented in `.superpowers/sdd/progress.md`):** foreground daemon (detached/socket-activation is post-v0 / v1.x — `daemon --detach` honestly returns exit 2); single global `~/.noir/daemon.json` (concurrent-project clobbering); no daemon auth token; full-screen Ink/blessed TUI (v2 — S9 ships a `@clack/prompts` menu, not a full-screen TUI); in-process read-only store fallback for `context *` / `memory *` / `task *` (daemon-required for v1; `status` is the only probe-only command); `task` id/slug distinction collapsed to slug for v1; cosmetic nits.

**Goal (North Star, unchanged):** Noir = the discipline/context/memory layer that makes any agentic CLI behave like a disciplined spec-driven engineer. v1 MVP = a solo power-user doing idea→spec→plan→implement inside Claude Code with persistent cross-session memory.

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
**Slices S10–S11.** Additional host adapters (OpenCode, Gemini, Agy, Qwen) with per-host emulation; Claude marketplace + npm publish; `noir doctor`; framework docs; SDK surface ("usable as a framework").
- **Milestone:** true cross-CLI + installable product.

### v2.0 — Ecosystem  *(long-term)*
- Cloud sync for memory (opt-in).
- Team / multi-user features: shared specs, plans, and memory across a team.
- First-class plugin/marketplace registry (Noir-native, not just Claude's).
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
| First-class Noir marketplace/registry | v2.0 | Claude marketplace suffices for v1 distribution. |
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
