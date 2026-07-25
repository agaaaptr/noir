# Noir — AI Toolkit Design Blueprint

- **Date:** 2026-07-23
- **Status:** Implemented (v1.0 feature-complete; see docs/roadmap.md). Note: this is a historical design doc — the illustrative package/structure details in §5.3/5.4/6.5 evolved during implementation; for the shipped reality see `docs/roadmap.md` + `packages/`.
- **Owner:** agaaaptr
- **Session:** Discovery, architecture, and blueprint (implemented across S0–S9)
- **Supersedes (direction):** the `ai-toolkit` marketplace / `ai-dev-workflow` plugin identity
- **Companion docs:** `docs/roadmap.md` (living forward plan), `docs/decisions/` (ADR series, to be created at impl)

---

## 0. TL;DR

**Noir** is a **standalone, host-agnostic AI development toolkit** that turns any agentic CLI (Claude Code, Gemini CLI, OpenCode, Agy, Qwen, …) into a disciplined, spec-driven development partner with **native context management and long-term memory**.

Noir is **not** another LLM runtime. It is an **orchestration layer**: the host CLI is the execution engine (the muscle); Noir is the workflow, context, and memory brain. "Standalone" means Noir's own flow depends on **no other plugin** — the capabilities of Superpowers, Context Mode, and Agent Memory are re-implemented as **original native Noir features**.

- **Distribution:** `npm` / `npx noir`, an interactive TUI home screen, plus per-host adapters.
- **v1 target:** a solo power-user doing idea → spec → plan → implementation inside **Claude Code**, with persistent cross-session memory.
- **North star:** the foundation of the **Noir AI ecosystem**.

---

## 1. Background & Current State

The repository today is a **Claude Code plugin marketplace**, not a product:

- `.claude-plugin/marketplace.json` — marketplace `ai-toolkit`, single plugin `ai-dev-workflow`.
- The plugin is **pure markdown skills** (`/init`, `/sync`, `/flow`, `/wrap`, `/checkpoint`) + `references/` + `templates/`. There is **no `package.json`, no CLI binary, no Node/TS runtime, no agent loop.**
- It runs **inside Claude Code** and currently *delegates* to three other plugins (Superpowers, context-mode, agentmemory) when present, falling back to a "lean" inline mode otherwise (the "2-mode" work in recent commits).
- A clean `docs/` structure exists (specs / plans / decisions / architecture / findings).

**Implication:** the redesign is a 0→1 product build, not a refactor. The existing markdown skills are **reusable as canonical skill source material** (low migration waste); the rename/rebrand is mechanical.

---

## 2. Vision & North Star

> **Noir is the discipline, context, and memory layer that makes any AI CLI behave like a disciplined spec-driven engineer.**

- **The muscle** = the host CLI (LLM calls, tool execution, sandboxing).
- **The brain** = Noir (spec-driven lifecycle, working context, long-term memory, skills).
- **Bring your own agent.** Noir adapts to whichever CLI the user already runs.

**Long-term north star:** Noir becomes the foundation of the **Noir AI ecosystem** — a portable, extensible toolkit that works across every major agentic CLI, with native memory/context, and eventually team + ecosystem capabilities. v1 is deliberately scoped (solo, one host) to reach a sharp, competitive experience fast; the architecture is designed so the long-term vision is reachable without rework. See `docs/roadmap.md`.

---

## 3. Goals & Non-Goals

### v1 Goals
- `noir` / `npx noir` Node/TS application with an interactive home screen + onboarding.
- Portable `.noir/` store (single source of truth) + `~/.noir/` user-global memory.
- Opinionated-but-escapable **Spec-Driven Development** lifecycle (full pipeline + review gates; every phase skippable; quick mode).
- Native **working-context** management (indexing, retrieval, budgeting).
- Native **long-term memory** (typed, recall, consolidation, governance).
- Builtin skill pack + canonical skill format compiled to the host.
- **Claude Code** as the first (and v1-only) host, behind an abstract `HostAdapter`.
- Optional **bounded model layer** (spec/plan/summarize help) that degrades gracefully to pure orchestration when no API key is set.
- Auto-managed **daemon** + **Noir MCP server** as the runtime authority and universal host integration.

### v1 Non-Goals (deferred — see roadmap)
- Hosts beyond Claude Code (Gemini/OpenCode/Agy/Qwen — v1.x).
- Cloud sync for memory; team/multi-user features (v2.0).
- A first-class plugin marketplace/registry (retained only as a Claude Code distribution channel).
- Programmatic headless driving of host CLIs (e.g. `claude -p` orchestration).
- Full theming/plugin-SDK surface.

---

## 4. Key Decisions (Decision Log)

Each decision records **why** and the **alternatives rejected**, so future maintainers understand intent.

| # | Decision | Chosen | Alternatives considered | Rationale |
|---|---|---|---|---|
| D1 | Host/runtime model | **Cross-CLI orchestration layer** (BYO-agent) | Standalone LLM runtime; pure Claude Code plugin | User intent: "standalone" = no *other* plugins in Noir's flow, not "no host." Reusing the user's existing CLI as executor avoids rebuilding a model runtime; orchestration is the real wedge. |
| D2 | UI / entry-point | **Orchestrator-first** (`noir` TUI home screen) | Host-native layer only; hybrid | Matches "interactive home screen" + "`npx noir`"; can evolve to hybrid later. |
| D3 | v1 target user | **Solo power-user** (idea→spec→plan→implement) | Small team; public OSS product | Sharp, usable v1 for the author first; broaden later. Long-term stays "ecosystem foundation." |
| D4 | SDD style | **Opinionated-but-escapable** | Strict pipeline; flexible menu | Discipline by default with an always-available escape hatch; evolves the existing `/flow` philosophy. |
| D5 | LLM boundary | **Hybrid (bounded)** — thin optional model layer; delegates impl to host | Pure orchestration; full model layer | Best UX (automated drafting) without duplicating the host agent; graceful no-key degradation preserves pure-orchestration robustness. |
| D6 | Context + memory | **Unified** (durable recall + working-context budgeting) | Recall-only; context-budget-only | User wants both inspirations native; one coherent "Noir brain" is cleaner than two silos. Scope: project-local store + optional user-global; no cloud sync v1. |
| D7 | Process model | **Auto-managed daemon** (with FS fallback) | Stateless; single-process TUI | Live shared state, continuous background jobs, uniform host integration; graceful degradation inherits stateless robustness. |
| D8 | Canonical skill format | **Adopt Claude Code `SKILL.md` as base** + Noir frontmatter | Bespoke Noir schema | Richest format; natively shared by Qwen/Agy; lowest emulation cost. |
| D9 | v1 host scope | **Claude Code only** | Claude + one more host | Richest extension model + author's env; abstract `HostAdapter` keeps generalization cheap (mechanical, not architectural). |
| D10 | Naming | **Brand "Noir", scoped IDs** (`@noir-ai/*`, bin `noir`) | Bare `noir` everywhere; distinct variant name | "Noir" has heavy collisions (Aztec ZK language, Homebrew security tool); scoping keeps the brand clean and avoids squatting/SEO clashes. Exact IDs verified at impl. |

---

## 5. Architecture

### 5.1 Layered model

```
┌──────────────────────────────────────────────────────────────┐
│  HOST CLIs  (Claude Code · Gemini · OpenCode · Agy · Qwen)    │ ← execution engines (BYO-agent)
└───────────▲────────────────────────────────────────▲─────────┘
   MCP tools │              context @import + generated skills/cmds/hooks │
┌────────────┴───────────────────────────────────────┴──────────┐
│  ADAPTER LAYER  — N thin host emitters (one per CLI)           │ ← generates host-native artifacts
├────────────────────────────────────────────────────────────────┤
│  NOIR CORE  (CLI-agnostic)                                     │
│   Daemon(process) · Stores · SDD Workflow Engine ·             │
│   Bounded Model Layer · Noir MCP Server ·                     │
│   Skill/Command/Hook Compiler · Scaffolder                    │
├──────────────────────────────────────────────────────────────── ┤
│  NOIR TUI (thin client)   +   `noir` CLI commands              │ ← user-facing
└────────────▲───────────────────────────────────────────────────┘
             │  single source of truth
   .noir/ (project)            ~/.noir/ (user-global)
```

### 5.2 Governing principles
1. **One CLI-agnostic core; hosts are thin targets** — never fork logic per host.
2. **`.noir/` is the single source of truth** — generated artifacts are pointers/transforms, never copies that drift.
3. **Daemon is the runtime authority** — TUI and hosts are clients.
4. **MCP = dynamic intelligence; static artifacts = declarative context/permissions/commands.**
5. **Graceful degradation everywhere** — no key → pure orchestration; daemon down → direct store; host lacks feature → emulate.

### 5.3 Package structure (monorepo, `@noir-ai/*`)

| Package | Responsibility | v1 note |
|---|---|---|
| `@noir-ai/core` | Domain models, store *interfaces*, workflow engine, skill compiler, types — **no I/O** (the "usable as framework" surface) | core |
| `@noir-ai/store` | SQLite/FTS5 impls: context index, memory store, state store | core |
| `@noir-ai/daemon` | Long-lived process: owns stores, background jobs, auto-managed lifecycle | core |
| `@noir-ai/mcp` | Noir MCP server (stdio + HTTP/SSE) — universal host integration | core |
| `@noir-ai/adapters` | `HostAdapter` interface + emitters (`claude` first; `gemini`/`agy`/`opencode`/`qwen` later) | claude first |
| `@noir-ai/cli` | The `noir` bin + TUI home screen (thin daemon client) + onboarding | core |
| `@noir-ai/model` | Bounded model layer (Anthropic/OpenAI/Google/local) | optional path |
| `@noir-ai/skills` | Builtin Noir skill pack (SDD lifecycle) in canonical format | core |
| `@noir-ai/create` | `npx noir init` scaffolding + templates | core |

*(v1 may merge `daemon`+`mcp`+`model` into one runtime package to cut surface; logical boundaries stay.)*

### 5.4 The `.noir/` portable store (single source of truth)

```
.noir/
  NOIR.md            ← canonical context file (host files just @import this)
  config.yml         ← hosts enabled, model prefs, SDD mode
  state/             ← workflow.json (current task/phase), sessions/
  specs/  plans/  tasks/  decisions/   ← SDD lifecycle artifacts
  memory/            ← durable recall store (sqlite + markdown export)
  context/           ← working-context index (FTS5 over codebase/docs)
  skills/<name>/SKILL.md   ← canonical skill format (user + builtin)
  agents/  commands/  hooks/   ← canonical defs (→ emitted per-host)
  mcp/manifest.json  adapters/   ← MCP manifest + generated host artifacts
~/.noir/             ← mirrors: global memory, config, global skills
```

---

## 6. Subsystem Designs

### 6.1 SDD Workflow Engine  (`@noir-ai/core`)

The opinionated-but-escapable lifecycle, made **stateful** (survives sessions → cross-session resume).

```
Intake → Clarify → Spec ─► Plan ─► Execute ─► Verify ─► Document
                   [GATE]     [GATE]              [GATE]
```

| Phase | Output artifact | Notes |
|---|---|---|
| Intake | `intake.md` | raw idea / ticket / issue |
| Clarify | `clarifications.md` | bounded model surfaces ambiguities → questions; resolved assumptions logged |
| Spec | `specs/<id>-<slug>.md` | what/why, acceptance criteria, constraints, **non-goals** |
| Plan | `plans/<id>.md` + `tasks/<id>/*` | technical design + task breakdown |
| Execute | impl + task-status deltas | hands tasks to the host CLI |
| Verify | test/lint/acceptance results | validates against spec criteria |
| Document | doc deltas + CHANGELOG + ADR | + memory consolidation |

- **State machine** per task: `draft → clarifying → specified → planned → executing → verifying → done` (+ `blocked`/`abandoned`), persisted in `state/workflow.json`.
- **Modes:** Full (default, all gates) · Quick (skip → execute, still stubs a spec + runs verify) · Resume (home screen detects in-flight work). Any gate bypassable via `--force` (logged). Jump-to-any-phase allowed (entry point recorded).

### 6.2 Context management — working context  (`@noir-ai/store` + daemon)

Keeps the host agent **focused within its context budget** (Context Mode idea, native).

- **Index:** FTS5 (SQLite) over codebase + docs + Noir's own specs/plans; incremental; daemon reindexes on file-change (background watcher).
- **Retrieve:** `noir.context_search(query)` → ranked chunks via **FTS5 + Reciprocal Rank Fusion** (Porter-stemming + trigram matchers), proximity rerank, fuzzy correction, **window-extracted snippets (never truncated)**.
- **Continuity:** tool calls captured as structured events; on compaction, build a **table-of-contents + runnable-query snapshot** (retrieve-on-demand, zero loss), restored next session.
- **Budget:** Noir estimates assembled-context tokens and prunes/prioritizes (essential-brief pattern).
- **Exposure:** (a) daemon auto-maintains an essential-brief section in `NOIR.md`; (b) MCP tools for on-demand retrieval.
- **Summarization:** bounded model compresses large outputs before they bloat context.

### 6.3 Memory management — durable recall  (`@noir-ai/store`)

Makes the agent **remember across sessions** (Agent Memory idea, native). **Unified with context.**

- **Types:** `pattern · decision · preference · fact · bug · architecture · session(recap)`.
- **Storage:** embedded SQLite + `sqlite-vec` (in-process, no server) + markdown export; `.noir/memory/` (project) + `~/.noir/memory/` (user-global, cross-project); keyed by a **canonical project ID (never a filesystem path)**.
- **Capture:** explicit (`noir.memory_save`) **+ auto** at lifecycle events (decisions at gates, recap at wrap, error→fix pairs).
- **Consolidation:** daemon background job — dedupe, summarize, cross-link; LLM consolidation is **opt-in and provider-explicit (never silent)** to avoid surprise cost/privacy.
- **Recall:** `noir.recall(query)` — hybrid BM25 + vector (local embeddings, no API key required) + auto-inject relevant memory into the brief at session start.
- **Governance:** `noir.memory_forget`, export, audit trail (privacy control).

### 6.4 Skill system  (`@noir-ai/skills` + compiler in `core`)

- **Canonical format:** markdown `SKILL.md` + frontmatter (`name`, `description`, `phase`, `host-tools`, `references/` for progressive disclosure). Claude Code's `SKILL.md` as the base, with Noir frontmatter layered on. **Authoring rule:** the `description` describes **WHEN** to use the skill, never **WHAT** it does (a what-summary becomes a shortcut the agent follows instead of loading the body).
- **Builtin pack** = the SDD lifecycle as skills (`intake`, `clarify`, `spec`, `plan`, `execute`, `verify`, `document`, `checkpoint`, `sync`) + power skills (`debug`, `brainstorm`, `review`) — **original Noir re-implementations** of the best Superpowers concepts.
- **User skills:** drop into `.noir/skills/<name>/SKILL.md` → auto-discovered.
- **Compiler/emitter:** canonical → host-native (Claude/Qwen/Agy copy; Gemini bundles into extension; OpenCode down-converts to command+agent). Progressive disclosure preserved where supported.
- **Enforcement:** discipline is **default-on but quiet and observable** — at decision points a neutral nudge that a skill may apply, with firing recorded (no rhetorical intimidation; always escapable — D4).

### 6.5 Adapter layer  (`@noir-ai/adapters`)

- **`HostAdapter` interface:** `init · emitContext · emitSkills · emitCommands · emitHooks · emitMcpConfig · install · healthCheck` — one impl per host.
- **Per-host emitters** (from host-integration research, §8):
  - `claude` — `CLAUDE.md` @import + `.claude/{skills,agents,commands}` + `settings.json` hooks + `.mcp.json` (+ optional `.claude-plugin` marketplace). **Fullest.**
  - `qwen` — `QWEN.md` @import + `.qwen/skills` + `settings.json` hooks (**shared schema w/ Claude**) + `mcpServers`. No installer (file drop).
  - `gemini`/`agy` — `GEMINI.md` @import + extension/plugin bundle (`gemini-extension.json`/`plugin.json`, **TOML** commands, `hooks.json`, `mcpServers`). Shared Gemini/Agy base adapter.
  - `opencode` — `AGENTS.md` + `instructions` glob + `.opencode/{agents,commands}` (skills **down-converted**) + `opencode.json` `mcp` + **generated TS plugin shim** for hooks.
- **Emulation registry:** documents each gap + workaround (OpenCode skills/hooks, Qwen subagents → `noir.dispatch` MCP tool).
- **Idempotent generation:** `noir sync` reconciles via marker-comment blocks — never clobbers manual edits.

### 6.6 Daemon + MCP server  (`@noir-ai/daemon` + `@noir-ai/mcp`)

- **Lifecycle:** socket-activated by `noir`/host-spawn; idle-stop; PID/socket in `~/.noir/`; single writer to stores; health endpoint.
- **MCP tool surface (universal):** `noir.recall · context_search · memory_save · spec_* · plan_* · task_* · checkpoint · dispatch · host_status`. Transports: **stdio** (host spawns) + **HTTP/SSE** (daemon) — every host integrates identically.
- **Background jobs:** indexing, memory consolidation, file watcher.
- **Degradation:** daemon unreachable → `noir` opens stores directly (read-mostly) + warns.

### 6.7 Bounded model layer  (`@noir-ai/model`)

- **Provider abstraction:** Anthropic / OpenAI / Google / local (Ollama). Config in `.noir/config.yml` + env keys.
- **Bounded tasks only:** spec/plan drafting, clarify-question generation, summarization, memory consolidation, home-screen help — **never the implementation loop**.
- **Graceful no-key mode:** no provider configured → tasks fall back to templates/user-filled. Noir stays fully functional.
- **Security:** keys in env/secret store, never committed. **Hard rule:** this layer never runs a tool/exec loop.

### 6.8 CLI / TUI / home screen  (`@noir-ai/cli`)

- **Onboarding (`noir init` / first run):** detect stack → choose host CLI(s) → scaffold `.noir/` → generate adapters → (optional) model key → welcome.
- **Home screen (interactive `noir`):** header (project · host status · SDD mode); **active spec/task** with phase + gate indicator; **recent memory**; **quick actions** (New feature · Quick task · Continue · Explore · Sync · Host hand-off). Noir-branded theming.
- **Commands:** `noir init · sync · flow [phase] · recall · add-host <cli> · doctor · ui`.
- **Tech:** Node + ink/clack-style TUI.

---

## 7. Data Flow — "idea → shipped feature"

1. `noir` → TUI connects to daemon → home screen: project, active spec/task, recent memory, host status.
2. **New feature** → intake → daemon's bounded model drafts a spec outline (or, no-key: TUI emits a fillable template) → **spec review gate**.
3. Spec approved → daemon generates **plan + task breakdown** → **plan review gate**.
4. User picks a task → Noir assembles context (index + memory recall) into the host's context file, then **hands the task to the connected host CLI** (the brain).
5. Host implements, calling Noir MCP tools as it works: `recall`, `context_search`, `memory_save`, `checkpoint`.
6. Daemon watches via MCP → on completion → **verify gate** → memory consolidation + spec/plan status update + changelog entry.

---

## 8. Host Integration Research Summary

Researched from official docs (Claude Code, Gemini CLI, OpenCode, Agy/Antigravity, Qwen Code). Key findings driving the adapter design:

- **MCP is the *only* extension point present and schema-compatible on every host** → Noir's "live" integration = one Noir MCP server (stdio + HTTP/SSE) all hosts connect to.
- **`@import` in the context-file is native in 4/5** (OpenCode uses an `instructions` glob array) → Noir owns one canonical `.noir/NOIR.md`; each host's context file just includes it. **Zero duplication.**
- **Universal floor:** context-file + `@import` + MCP + slash commands. **Near-universal:** skills (4/5); declarative hooks (Claude+Qwen share one schema). **Gaps to emulate:** OpenCode skills (→ commands/agents) and code-only hooks (→ TS plugin shim); Qwen subagents (→ `noir.dispatch` MCP tool); commands are markdown in 3 hosts but **TOML** in Gemini/Agy.
- **Install UX:** Claude (`/plugin`), Gemini (`extensions install`), Agy (`plugin install`), OpenCode (npm/file-drop), Qwen (none — file drop).

*(Full per-host breakdown lives with the adapter implementation; this summary captures the architectural implications.)*

---

## 9. Feature Adoption Analysis (Superpowers · Context Mode · Agent Memory)

*Sourced from the three plugins' actual files on disk (all installed locally). Noir adopts the **ideas**, re-implemented as original native designs — never copies.*

### 9.1 Superpowers — process-discipline skill layer
- **Concept:** a library of "skills" (markdown playbooks: TDD, systematic-debugging, brainstorming, code-review…) loaded on demand, plus a bootstrap that forces the agent to check for a skill *before* any response.
- **Key mechanisms (non-obvious):**
  - **SessionStart injection, not a file** — the routing instruction is ephemeral per-session (emitted as `additionalContext`); nothing is written to the user's project.
  - **Progressive disclosure** — at rest only the YAML `description` sits in the namespace; the body loads via the `Skill` tool only when triggered.
  - **"Description = WHEN, never WHAT"** — the single most exportable authoring rule: a description that summarizes the workflow becomes a *shortcut* the agent follows instead of reading the body. "Use when executing plans" works; "dispatches subagent per task…" breaks.
  - Persuasion psychology (Authority/Commitment/Social-Proof) + an anti-rationalization table pre-empting escape hatches.
- **Weaknesses:** enforcement is **purely rhetorical** (no real PreToolUse gate — a model that rationalizes once silently skips the skill); ALL-CAPS tone causes **over-triggering** on trivial asks; no cross-session learning; flat namespace scales poorly past ~20 skills.
- **Noir adaptation:** keep the **format + the description-is-trigger rule verbatim**; curate to a tight opinionated core (brainstorm → plan → TDD → debug → verify), rest user-opt-in; make it **host-agnostic and escapable** (D4). **Replace rhetoric with one quiet, observable programmatic checkpoint** — at decision points append a neutral nudge ("a skill may apply: X") and **record whether it was invoked** → evidence-based nudge + observability over intimidation.

### 9.2 Context Mode — Think-in-Code (keep raw bytes out of context)
- **Concept:** do derivation work in a sandbox and persist outputs to an FTS5 knowledge base + session DB, so only the *answer* enters the conversation (claimed ~98% context reduction).
- **Key mechanisms (non-obvious):**
  - **FTS5 + Reciprocal Rank Fusion** — two independent rankers per query (Porter-stemming + trigram-substring) merged via RRF; multi-term proximity rerank; Levenshtein fuzzy correction; snippets are **window-extracted around matches, never truncated**.
  - **Unified multi-source search** — content store (BM25) + session DB (prior sessions) + an auto-memory adapter reading other tools' formats; project scoping via a session-id allow-set.
  - **Compaction continuity** — every tool call captured as a structured `SessionEvent` (13 categories); PreCompact builds a **table-of-contents + runnable-search-query snapshot** (retrieve-on-demand, zero truncation/loss), restored at SessionStart.
  - PreToolUse **security deny** (reuses the host's own permission syntax) + flood-guard throttling.
- **Weaknesses:** **19-IDE adapter matrix** + `heal-*`/cache-integrity self-repair scripts (install fragility); **Elastic-2.0 license** (not clean OSS); a giant bossy injected routing block; a separate always-on MCP server + single-writer SQLite serialization.
- **Noir adaptation:** adopt **Think-in-Code + FTS5 + the RRF dual-ranker + window-snippets nearly intact** (this part is excellent). **Embed the store** (no sidecar server); make the compaction snapshot a **concise inline summary by default, retrieve-on-demand opt-in**; cut to **one host** (own the harness, no adapter matrix); replace the bossy prompt with a **short neutral routing hint**; re-license **truly OSS**.

### 9.3 Agent Memory — long-term memory across sessions
- **Concept:** persistent, searchable memory that **silently auto-captures** what the agent does and compresses it, replacing stale capped context-file notes.
- **Key mechanisms (non-obvious):**
  - **Silent auto-capture via hooks** (PreToolUse/PostToolUse/UserPromptSubmit/Stop/SessionEnd) — zero manual `save()` calls.
  - **Hybrid BM25 + vector** — local `all-MiniLM-L6-v2` embeddings (free, no API key) or Voyage/OpenAI; tunable weights + token budget.
  - **4-tier consolidation** (raw → consolidated) with decay/graph-extraction/pinned-slots/reflect/inject; memory **types**: pattern/preference/architecture/bug/workflow/fact.
  - **Governance:** audit trail, `delete-with-reason`, export, and a **canonical project ID (explicitly NOT a filesystem path — paths break across machines)**.
  - Progressive tool surface (`core`=8 / `all`=53); session **replay**; a **standalone-JSON** fallback needing no engine.
- **Weaknesses:** **heavyweight** (separate always-on server, pinned Rust engine, optional Docker, port juggling, Stop-hook recursion risk); **53 tools** overwhelming; consolidation **silently calls a paid LLM** when a key is present; scope-identity footgun; LLM-judge consolidation can hallucinate/lose signal.
- **Noir adaptation:** keep **hybrid search + auto-capture + governance + canonical project ID**; **kill the runtime** — embed vector search in-process (`sqlite-vec`), **single project-local file** (the standalone-JSON model promoted to primary); adopt the 4 types + audit/reason-on-delete verbatim; make LLM consolidation **opt-in and provider-explicit (never silent)**; expose **~6 curated tools** (borrow the `core`/`all` progressive-surface idea). Capture stays a **by-product of the SDD lifecycle** (decisions at gates, recap at wrap), not a manual chore.

### 9.4 What Noir deliberately does NOT copy
- Superpowers' **ALL-CAPS rhetorical intimidation** / anti-rationalization haranguing — replace with a quiet, observable checkpoint.
- Context Mode's **19-IDE adapter matrix** + `heal-*` script sprawl; its **Elastic-2.0 license**; its **bossy injected tool-hierarchy block**; its **separate always-on MCP server** as a given (embed it).
- Agent Memory's **external server + pinned Rust engine + Docker**; its **53-tool surface**; its **silent paid-LLM consolidation**; the **"scope = filesystem path"** pattern anywhere.
- **Truncating search snippets** (all three reject this) — Noir keeps window-extracted snippets; never blind `head`/`tail` cuts.

---

## 10. Decomposition into Buildable Slices

Each slice is independently valuable, has clean interfaces, and gets its own spec → plan → implement cycle (Noir dogfooding its own SDD).

| Slice | Builds | Milestone |
|---|---|---|
| **S0 · Foundation** | monorepo (`@noir-ai/*`), TS/build/CI, branding/rename, `.noir/` layout + `NOIR.md` + config schema, `@noir-ai/core` types | architecture stands up |
| **S1 · Stores** | `@noir-ai/store` — SQLite/FTS5: state, context index, memory | persistence exists |
| **S2 · Daemon + MCP skeleton** | auto-managed daemon + MCP server (stdio+HTTP), minimal tool surface | **walking skeleton — a host connects to Noir** |
| **S3 · Claude Code adapter + scaffolder** | `HostAdapter` iface + claude emitter, `noir init` | **first end-to-end vertical** |
| **S4 · SDD workflow engine** | state machine, phases, gates, escapability, resume | the differentiator runs |
| **S5 · Builtin skills + compiler** | SDD skills + power skills, canonical→host compiler | the workflow is usable |
| **S6 · Context management** | indexing/watcher, `context_search`, budgeting, essential-brief | host agent stays focused |
| **S7 · Memory management** | types, capture (explicit+auto), recall, consolidation, governance | cross-session memory |
| **S8 · Bounded model layer** | provider abstraction, bounded tasks, graceful no-key | automated drafting |
| **S9 · CLI/TUI home screen** | interactive `noir`, onboarding, commands | **v1.0** |
| **S10 · More host adapters** | gemini/agy/opencode/qwen emitters + emulation | true cross-CLI (v1.x) |
| **S11 · Distribution + SDK + docs** | marketplace publish, npm, framework docs, `noir doctor` | installable product (v1.x) |

**De-risk principle:** front-load a **walking skeleton** (thinnest S0→S2→S3) proving the thesis — *a host CLI connects to Noir over MCP and one tool round-trips* — before deepening any single subsystem.

---

## 11. Risks & Trade-offs

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Daemon lifecycle fragility (highest blast radius) | 🔴 | auto-manage + socket-activate + **FS fallback** + `noir doctor` |
| 2 | Host extension-format drift (CLIs evolve) | 🟠 | per-adapter version-pinned tests, `doctor` checks, emulation registry |
| 3 | Emulation gaps (OpenCode skills/hooks, Qwen subagents) | 🟠 | degraded-but-functional per host, documented |
| 4 | Scope creep / over-engineering | 🟠 | strict v1 = one host; YAGNI on cloud/team/marketplace-first-class |
| 5 | No-key graceful mode is a broken half | 🟠 | treat pure-orchestration as a **first-class, tested** mode |
| 6 | Two-brains confusion (Noir model + host agent) | 🟡 | hard rule: Noir's model **never** runs a tool/exec loop |
| 7 | Memory staleness / wrong recall | 🟡 | staleness flags + governance + verify-before-acting |
| 8 | Migration waste from current repo | 🟢 | low — existing markdown skills reusable as canonical source; rename is mechanical |
| 9 | Naming namespace (`noir` bin/pkg availability) | 🟡 | scoped `@noir-ai/*`; verify exact IDs at impl |
| 10 | Token/cost of bounded model + indexing | 🟡 | opt-in, budgeted, no-key path always available |

---

## 12. Open Questions / To-Verify at Implementation

- Confirm exact availability: npm `@noir-ai/*` scope + `noir` bin; GitHub repo/org name; Homebrew formula (likely taken — use scoped/cask if needed).
- Confirm Claude Code does **not** auto-load `AGENTS.md` (research suggests `CLAUDE.md` is canonical) — affects whether Noir writes one file or two.
- Confirm Qwen Code custom-command file format (markdown vs TOML) and whether subagents exist (assumed absent → emulate).
- Confirm OpenCode plugin hook event taxonomy for the generated TS shim.
- Decide repo-rename timing (recommended: at impl start, with `develop` branch).

---

## 13. Glossary

- **Host CLI** — the agentic CLI that executes LLM/tool work (Claude Code, Gemini, etc.).
- **Orchestrator** — Noir's role: workflow + context + memory, delegating execution to the host.
- **Daemon** — Noir's long-lived runtime process; the single writer and MCP host.
- **Adapter** — a per-host emitter that translates the canonical `.noir/` store into a host's native artifacts.
- **SDD** — Spec-Driven Development (Noir's lifecycle).
- **Walking skeleton** — thinnest end-to-end slice proving the integration thesis.

---

## 14. Next Steps (this session → impl)

1. **This session:** write & commit this blueprint + `docs/roadmap.md`; await user review.
2. **At impl start:** lock exact identifiers; rename repo + cut `develop` branch; promote roadmap/vision into durable root docs; create ADR series in `docs/decisions/`.
3. **First implementation cycle:** brainstorming → spec → plan → implement the **S0→S2→S3 walking skeleton** (Noir dogfooding its own SDD).
