# Noir v1.x Capabilities — Design Analysis

> **Status:** Analysis / research / design exploration. **NOT an implementation spec.** Produced 2026-07-25.
> **Scope:** Five candidate capabilities for post-v1.0 Noir — (1) PRD as core capability, (2) Rule generation at init, (3) Ignore management, (4) Integration skill system, (5) Intelligent scaffolding.
> **Method:** Grounded in the actual on-disk v1.0.0-beta.1 architecture + 5 parallel web-research agents (≈150 sources) + codebase verification of load-bearing claims. No assumptions: every architectural claim about Noir was verified against the code; every external claim is cited.
> **Companion docs:** `docs/internal/specs/2026-07-23-noir-toolkit-design.md` (blueprint + §9 feature-adoption doctrine), `docs/roadmap/` (living forward plan).

---

## 0. Locked scope decisions (confirmed with the user)

| Topic | Decision | Implication |
|---|---|---|
| #5 Scaffolding | **AI-layer only** | Noir owns `.noir/` + AI artifacts + host wiring. Code structure (`src/`, `packages/`, `apps/`) is delegated to existing scaffolders (`pnpm create`, create-t3, Nx). Noir *composes*, never competes. |
| Host horizon | **v1.x, Claude-first** | Design multi-host-ready via `HostAdapter`; ship Claude Code first. Multi-host emission (AGENTS.md/Cursor/Gemini) layers in with S10. |
| #4 Integration | **Skill + optional runtime tier** | Default = skill-only (generalize the ClickUp REST precedent). Runtime adapter (MCP/auth) only when genuinely stateful. |
| #1 PRD | **Pre-SDD artifact, optional by mode** | `.noir/prd/` feeds the technical Spec; mandatory for feature/epic, skippable for quick-task. **No FSM change.** |

### Clarification round — resolved 2026-07-25

| Q | Decision |
|---|---|
| Q0a roadmap | **Sequential slices S12+** (K→Rules→Ignore→PRD→Scaffold→Integration), not a single bundled milestone |
| Q2a rules format | **Single `.noir/rules/RULES.md`** (AGENTS.md-compatible; compiler splits to `.cursor/rules/*.mdc` at S10) |
| Q4a first integration | **ClickUp skill-only + 2-way sync** (proves the skill-only default + implements backlog SP-6; no OAuth/keychain needed) |
| Q4b OAuth policy | **Refuse OAuth integrations until keychain lands** (never silently lower the security bar; refuse cleanly) |
| Q5a scaffold package | **Extract a NEW `@noir-ai/create` package** (manifest/templates/migrations/writers; `init`/`sync`/`doctor` in `cli` become thin callers) |
| Q5e create vs init | **Keep `@noir-ai/create` + add a `noir create` command** (`bin` → `npm create noir-ai` greenfield first-run, no install); `noir init` = attach/re-run/`--upgrade`; both share the engine. AI-layer only in both (code structure still from `pnpm create`/create-t3/Nx — composed, never wrapped) |

> Remaining clarifications (Q1a–c, Q2b–c, Q3a–c, Q4c, Q5b–d) are deferred to each slice's SDD spec.

---

## 1. Executive summary

The single most important finding: **all five capabilities are facets of one architectural pattern Noir already implements and proves in production.** Noir's recurring triad is:

1. **Canonical source in `.noir/`** (single source of truth).
2. **Host-facing artifacts as thin pointers/emissions** at conventional root locations, produced by *emitters* on `HostAdapter` (`emitMcpConfig`, `emitContext`, `emitSkillsToDir`).
3. **Managed-block markers** (`CONTEXT_BLOCK_BEGIN/END` in `@noir-ai/core/markers.ts`, applied by `replaceBlock()` in `init.ts`) that re-emit Noir-owned regions of user-co-owned files without clobbering user content.

**Verified on disk:** the marker primitive and the `replaceBlock()` managed-region writer already exist and already drive `CLAUDE.md` regeneration today. The skills compiler (`discoverBuiltin → parseFrontmatter → validateSkill → compileSkill → emitSkillsToDir`, with `CompileTarget='claude'` and a `FORBIDDEN_RESIDUE` predecessor-strip) is rich and extensible. `HostAdapter` + `McpConfigOptions` + `EmitContext` are in place.

Therefore the cross-cutting work is not five greenfield features — it is **one keystone refactor plus five extensions**:

- **Keystone (K):** generalize `replaceBlock()` into a shared **multi-marker managed-block writer**; generalize the skills compiler into a shared **canonical→host artifact compiler** (rules + skills + integrations flow through it); extend `HostAdapter` with `emitRules()` + integration-aware `emitMcpConfig()`.
- **T1 PRD:** a `prd` *artifact kind* in `@noir-ai/workflow` + a soft, escapable gate predicate on `taskClass` + a `noir-prd` skill + `draftPrd()` in the bounded model. No new phase.
- **T2 Rules:** canonical `.noir/rules/RULES.md` + `emitRules()` emitter; Claude gets a one-line `@.noir/rules/RULES.md` managed import in `CLAUDE.md`.
- **T3 Ignore:** an `IgnoreManager` + `IGNORE_BLOCK_BEGIN/END` sibling markers; hooked into `init`/`sync`; advisory + `noir doctor` for non-editable configs.
- **T4 Integration:** `skills/integrations/<name>/{SKILL.md,integration.json}` + compiler extension + a new `integrations_auth` MCP tool (kills the non-interactive-shell gotcha) + optional runtime tier (daemon-child MCP / config emit).
- **T5 Scaffold:** `noir init` grows from a thin writer into a **three-mode scaffold engine** (`regenerate` / `managed_block` / `skip_if_exists`) + `.noir/scaffold-version` + a declarative migrations manifest + stack-detect fill-gap; this is the *container* that emits rules/PRD/ignore seeds and orchestrates everything at init/sync.

**Recommended sequencing (v1.1 → v1.x):** K (keystone) → Rules → Ignore → PRD → Scaffold (container) → Integration. Detail in §10.

---

## 2. How this analysis was produced

1. **Grounding** — read the actual v1.0.0-beta.1 architecture (10 packages, SDD FSM, skills compiler, `noir init`/`sync`, config schema, HostAdapter, MCP tool surface, blueprint §9 doctrine, roadmap v1.x backlog). Every "current state" statement is verified.
2. **Scope decisions** — four load-bearing forks resolved with the user (§0) before research, so the 5 research agents had a precise target.
3. **Parallel research** — five `general-purpose` agents, one per topic, each with a self-contained brief (Noir context + locked decision + research questions + tools to investigate + output contract). Each returned a structured report with verified primary-source references.
4. **Cross-topic synthesis + codebase verification** — verified the load-bearing code claims (markers exist & are used; skills compiler API; HostAdapter/McpConfigOptions; **`@noir-ai/create` does NOT exist** — a correction to the scaffold agent's assumption).

---

## 3. The unifying architectural pattern (cross-topic)

```
                    ┌─────────────────────────────────────────────┐
                    │   .noir/  ← canonical source of truth        │
                    │   NOIR.md (context)  RULES.md (contract)     │
                    │   prd/  specs/  plans/  tasks/  decisions/   │
                    │   audit/  rules/  skills/  integrations/     │
                    │   config.yml  project.id  scaffold-version   │
                    └───────────────┬─────────────────────────────┘
                                    │  canonical→host artifact compiler
                                    │  (extends the skills compiler)
                    ┌───────────────▼─────────────────────────────┐
                    │   HostAdapter emitters (per host)            │
                    │   emitMcpConfig · emitContext · emitSkills   │
                    │   emitRules (NEW) · emitIgnore (NEW)         │
                    └───────────────┬─────────────────────────────┘
                                    │  three write-modes
            ┌───────────────────────┼───────────────────────┐
       regenerate              managed_block              skip_if_exists
   (pointers: CLAUDE.md,    (co-owned: CLAUDE.md       (user seeds: prd.md,
    AGENTS.md, .mcp.json,    context block, .gitignore  roadmap, ADRs, config
    emitted skills)          noir block, NOIR.md brief) templates — write once)
```

**Why this matters:** the user's instinct to bundle these five ideas is structurally sound — they are *the same mechanism applied to five artifact families*. Building the keystone (K) once makes each of the five an incremental extension rather than a standalone subsystem, and keeps Noir's identity intact (orchestration/context/memory brain; host = execution engine; `.noir/` = single source of truth; graceful degradation).

**Doctrine check (§9):** every recommendation below adopts *ideas* (managed blocks from Copier/Plop; canonical-source+@import from Claude's own AGENTS.md guidance; artifact-feeding from Kiro/Spec Kit; skill-only integration from the proven ClickUp precedent) and re-implements them as native Noir designs — never copies.

---

## 4. Per-topic analysis

Each topic follows: Requirement → Approaches compared → Best practices → Recommendation → Architecture impact → Risks. Full reference lists are consolidated in §11.

### 4.1 Topic #1 — PRD as core capability

**Requirement.** Noir's `intake → clarify → spec` chain conflates *requirement discovery* with *technical solution design*. For features/epics the product framing (problem, evidence, audience, success metric, out-of-scope) is load-bearing and gets lost inside a technical spec; for spikes/bugfixes it is dead weight. The design question is *where* the PRD lives, *when* it is mandatory, and *how the bounded model drafts it offline*.

**Approaches compared.**

| Approach | How | Pros | Cons | Fit |
|---|---|---|---|---|
| (a) Separate PRD doc feeding Spec (Kiro `requirements.md`→`design.md`→`tasks.md`) | PRD is its own artifact; spec `@import`s it | Clean separation; traceable; industry consensus (Kiro, Spec Kit, Gemini SDD) | More files; drift risk | **Best** |
| (b) PRD-as-section-in-spec | one doc, "Requirements" then "Design" | single source; no drift | mixes altitudes; can't skip for quick tasks | weak |
| (c) PRD-as-new-FSM-phase | add `prd` phase | explicit gate | **violates locked decision** | rejected |
| (d) PRD orthogonal/optional | `.noir/prd/` exists iff mode/class demands | zero cost when skipped; no FSM change | needs clear heuristic | **recommended** |

**Best practices (synthesized — Atlassian, Lenny, Shape Up, Amazon, Haberlah).** Canonical sections: *Problem · Evidence · Audience · Success Criteria (machine-verifiable) · Appetite/Mode · Proposed Direction · No-gos · Rabbit holes · Open Questions*. When-mandatory heuristic (Kiro is the cleanest precedent): feature/epic → full requirements+design+tasks; well-understood feature → Quick Spec; bug → Bugfix Spec; "vibe"/exploration → none. AI-generation that works: **grounding search/RAG before drafting** (Replit `replit-prd` marks Research *mandatory* — prevents hallucinated capabilities) → clarifying questions → structured template with machine-verifiable acceptance criteria → dependency-ordered PRD→design→plan.

**Recommendation.**
- **File:** `.noir/prd/<taskId>-<slug>.md`, sibling to `specs/`. Frontmatter `{ id, slug, taskClass, status, supersedes }`. Body sections per the synthesis above (Noir-flavored blend, not a copy of any single template).
- **Mandatory heuristic** gated on `taskClass` (which Noir already tracks), **not** a new phase: `feature | epic` → PRD required before `spec` will accept input; `bugfix | spike | quick-task | refactor` → skippable (Quick mode flows straight to spec/execute). Override via `--force <reason>` (consistent with existing gate doctrine), logged to audit.
- **Feeds spec by reference, not embed:** the spec's "Context/Requirements" section carries `@import ../../prd/<id>-<slug>.md` (mirrors how host files already `@import` `NOIR.md`). Spec frontmatter records `prdRef: <id>@<hash>` so a `noir verify` check can flag a stale PRD (Spec Kit's evolving-specs brownfield loop is the precedent).
- **Auto-generation triggers:** the bounded model drafts a PRD when (1) `taskClass ∈ {feature,epic}` *and* intake+clarify artifacts exist; (2) the user invokes `noir-prd`; (3) `noir init`/`sync` detects an external input (issue body, roadmap entry, pasted idea). Generation **always starts with a grounding step** (search `.noir/` memory + optional web), then asks clarifying questions, then produces the doc. No key → fillable template with the same sections (graceful degradation, matching S8's pattern).

**Architecture impact.**
- `@noir-ai/workflow`: no new phase; add a `prd` **artifact kind** alongside specs/plans/tasks; a predicate in `advance()` that, if `taskClass∈{feature,epic}` and no PRD exists, surfaces a soft (escapable) gate; new `writePrd()`/`readPrd()` in `artifacts.ts`.
- `@noir-ai/core/layout.ts`: add `prdDir`.
- `@noir-ai/skills`: ship `noir-prd` (SDD-lifecycle category); reuse `description=WHEN` enforcement.
- `@noir-ai/model`: add `draftPrd(intake, clarify, memory)` mirroring `draftSpec`; offline path emits the section template.
- `config.yml`: optional `prd: { mandatoryFor: [feature, epic] }`.
- Memory: PRD approval captured as a decision event (consistent with gate-capture).
- ⚠️ Cross-host: `@import` is Claude-specific today; Gemini/OpenCode hosts must *inline* PRD content at draft time (HostAdapter concern, S10).

**Risks.** Drift (PRD↔spec diverge → mitigate with `prdRef@hash` + `noir verify`); hallucinated requirements (mandatory grounding + Open Questions section; never let the model fill "Evidence" without a source); over-engineering/skills-forward bias (Appetite/Mode caps scope; No-gos mandatory).

---

### 4.2 Topic #2 — Rule generation at init

**Requirement.** Emit at `noir init` a working-contract rule set that becomes the host's always-on context: anti-fabrication, stay-in-scope, ask-first, follow-SDD, follow coding standards/ADRs/docs/conventions. Constraints: one canonical source; multi-host via `HostAdapter`; parallel to the skills compiler + the `NOIR.md` @import pattern; token-realistic (hosts inject rules into *every* session); regenerable without clobbering user edits; free of the ALL-CAPS rhetoric Noir rejects.

**Key research findings.** `AGENTS.md` is now a real cross-tool standard (~25 tools read it verbatim). Claude Code itself officially recommends `CLAUDE.md` `@import` an existing `AGENTS.md` rather than duplicate — *exactly* Noir's canonical-source + host-@import pattern. Length budgets: Claude <200 lines / Cursor <500 / Codex 32 KiB / Windsurf 12 K chars; production anecdote ≈6 KB / 120 lines (effective attention degrades in the low-thousands of tokens regardless of window size).

**Approaches compared.**

| Approach | Pros | Cons | Fit |
|---|---|---|---|
| A. One canonical `AGENTS.md`, no emission | zero drift; ~25 hosts read natively | Claude ignores `AGENTS.md`; loses Cursor globs / Claude `paths:` / Windsurf caps | insufficient alone (Claude is v1 host) |
| B. Canonical + compiler emits per-host (rulesync / ai-rules-sync model) | single source; per-host capabilities recoverable; idempotent; gitignorable outputs | compiler tracks N format quirks | **recommended** |
| C. Duplicate per host | native-max features per host | token drift, divergence, contradiction → "constraint-evasive fabrication" | rejected (anti-doctrine) |

**Best practices.** Pruning rubric (wordman): each line must be failure-backed (prevented a real issue in 30 days) OR tool-enforceable OR decision-encoding OR triggerable — else delete; "document failures, not aspirations." Structure: brief overview → verification commands → permissions (ask-first/never) → gotchas → conventions/ADRs (links, not bodies) → docs/roadmap pointers. Anti-fabrication phrased *positively and concretely* ("Use only files you have opened with Read"; "If a prerequisite is missing, ask before assuming"). Lifecycle: whole-file-generation + gitignore (rulesync default) OR generated-file-with-managed-region markers. **Claude strips block-level HTML comments before context injection**, so a `<!-- @noir-managed -->` header is token-free.

**Recommendation.**
- **Canonical source:** `.noir/rules/RULES.md` — single plain-markdown, AGENTS.md-compatible file, ≤150 lines / ≤6 KB. Sections in order: *Identity & scope → Anti-assumption contract → SDD workflow gates (link, don't reprint) → Verification commands → Coding standards (link to ADRs/docs) → Docs & roadmap pointers → Conventions gotchas*.
- **Compiler = new `emitRules()` on `HostAdapter`** (alongside `emitContext`/`emitSkills`), invoked from `init`/`sync`:
  - **Claude (v1):** append one line to the `CLAUDE.md` Noir already manages — `@.noir/rules/RULES.md`. Composes cleanly with the existing `@.noir/NOIR.md` context import: *context* via `NOIR.md`, *contract* via `RULES.md`, both canonical, zero duplication. Claude-specific extras (e.g. "use plan mode for `src/billing/`") go in a generated `.claude/rules/noir-claude.md` with `paths:` frontmatter. This is Claude's officially documented composition.
  - **AGENTS.md-native hosts (v1.x / S10):** emit a repo-root `AGENTS.md` = symlink to `.noir/rules/RULES.md` (Unix) or a generated shim with a `<!-- @noir-managed -->` header (Windows / symlink-averse tools).
  - **Cursor specifically:** additionally compile `.noir/rules/*.md` (one-per-topic) → `.cursor/rules/*.mdc` with `description`/`globs`/`alwaysApply` frontmatter, preserving auto-attach semantics the flat `AGENTS.md` loses.
- **Update safety:** generated artifacts re-written idempotently on every `noir sync` and gitignorable; a `<!-- @noir-managed -->` header documents non-canonicality at zero token cost on Claude; user-extensions live in `.noir/rules/RULES.local.md` (imported after `RULES.md`), never overwritten.
- **Package:** extend the skills compiler into a shared "canonical→host artifact compiler" (it already enforces `description=WHEN`, managed markers, Claude-only `CompileTarget` — the S10 widening the roadmap already plans). A separate `@noir-ai/rules` package is YAGNI for v1.x.

**Architecture impact.**
- `HostAdapter`: add `emitRules(ctx)`; `claude` adapter writes the `@.noir/rules/RULES.md` import line + optional path-scoped extras.
- Config: `rules: { enabled, hosts, sections, lengthBudgetKb: 6 }`.
- Builtin skill: `noir-rules` (rationale + worked examples for each clause — keeps always-on `RULES.md` thin).
- `noir doctor`: verify the @import resolves and `RULES.md` is under budget.

**Risks.** Cursor precedence with both `AGENTS.md` + `.cursor/rules/*.mdc` emitted (test needed; emit non-overlapping scopes); frontmatter lost on plain-AGENTS hosts (canonical carries optional frontmatter the compiler down-converts); contradiction → fabrication (phrase positively; test against the real Claude system prompt); length drift (wire `doctor` to flag >200 lines / >6 KB and propose trims).

---

### 4.3 Topic #3 — Ignore management

**Requirement.** Guarantee across any host project that `.noir/` and `~/.noir/` are invisible to VCS, packaging, containers, search, lint, format, static analysis, security scanning, and CI — and that this guarantee survives structure drift, re-synced idempotently and non-destructively. Two sub-problems: **exempt** the right artifacts per tool, and **commit** the right artifacts for team reproducibility. Crucial: `~/.noir/` lives *outside* the repo (never committed/published/scanned); the real ignore-management surface is project-root `.noir/`.

**Ignore-file matrix (researched).**

| Tool | File | What to add for Noir |
|---|---|---|
| git | `.gitignore` | `# >>> noir managed >>>` block: `/.noir/store/`, `/.noir/*.sock`, `/.noir/daemon.pid`, `/.noir/state/` |
| Docker | `.dockerignore` | `.noir/` (whole) |
| npm publish | `package.json` `files` (+ `.npmignore`) | Noir's own 10 pkgs: tight `files:["dist","bin","README*","LICENSE*"]`; user pkgs: rely on their `files` allowlist |
| npm publish (legacy) | `.npmignore` | `/.noir/` block — **`.npmignore` overrides `.gitignore` when both exist**, so it must be written too |
| ESLint 9+ | `eslint.config.js` `ignores` | advisory only (can't safely auto-edit JS config) |
| Prettier | `.prettierignore` | `/.noir/` block |
| ripgrep/fd/AI tools | `.ignore` | `/.noir/store/` (defensive; `.noir/` is hidden → rg/fd skip natively) |
| SonarQube | `sonar-project.properties` | `sonar.exclusions=**/.noir/**` |
| CodeQL | `.github/codeql/codeql-config.yml` | `paths-ignore: ['**/.noir/**']` |
| Dependabot | `.github/dependabot.yml` | **N/A** — scopes dependency *versions*, not files (honest non-issue) |
| VS Code | `.vscode/settings.json` | advisory (user logic lives here): `search.exclude`/`files.watcherExclude` |

**Commit-vs-ignore convention.** The derived vector/index DB is a build artifact → ignore (mirrors `dist/`, `.nx/`, `.turbo/`); markdown source artifacts → commit.

| Item | Commit? | Ignore? |
|---|---|---|
| `NOIR.md`, `config.yml`, `project.id`, `specs/`, `plans/`, `tasks/`, `decisions/`, `prd/`, `roadmap.md`, `rules/` | ✅ | — |
| `store/*.db`, `*.sock`, `daemon.pid`, `state/` | — | ✅ |
| `mcp/manifest`, `adapters/`, `audit/` | user-choice (derived/transparency) | optional |
| `~/.noir/models/`, `~/.noir/daemon.json` | n/a (outside repo) | local cache |

**Managed-block recommendation.** Three strategies exist: idempotent append+dedup (can't remove stale entries), fully-generated whole file (forces "never edit," hostile to mixed-tool projects), **managed block delimited by markers (recommended)**. This is **already Noir's pattern**: `CONTEXT_BLOCK_BEGIN/END` + `replaceBlock()` in `init.ts`. Add an `IGNORE_BLOCK_BEGIN/END` sibling sentinel so the two never collide; embed a schema version inside the marker for upgrades.

```
# >>> noir managed (schema v1) >>>
/.noir/store/
/.noir/*.sock
/.noir/daemon.pid
/.noir/state/
# <<< noir managed <<<
```

**Safety rules (Ruler #600 bug):** treat *only* a complete marker pair as a managed block; an unterminated start marker → preserve existing content unchanged + append a fresh well-formed block; de-duplicate only inside complete blocks.

**Recommendation.**
- **`IgnoreManager`** module (in `@noir-ai/core` alongside `markers`, or a thin fs concern): a declarative registry `{ tool, file, entries[], schemaVersion }[]` + `syncIgnores(root)` that rewrites each managed block idempotently. Derive the entry set from the paths `layout.ts` already knows (don't hardcode) — keeps the "derived=ignore / source=commit" split in one place.
- Reuse the `CONTEXT_BLOCK` marker primitive — add `IGNORE_BLOCK` (same shape, different sentinel).
- **Hook** into `noir init` + `noir sync` (both already idempotent generators).
- **Non-editable configs** (ESLint flat `ignores`, VS Code `settings.json`, CodeQL YAML): emit a one-time instruction + a `noir doctor` check, **not** silent edits — these files hold user logic.
- **Efficacy verification:** `git check-ignore -v .noir/store/x.db` and `npm pack --dry-run` in `noir doctor`.

**Architecture impact.** New `IgnoreManager` in core; `IGNORE_BLOCK_BEGIN/END` in `markers.ts`; new `syncIgnoreFiles()` step in init/sync; `noir doctor` checks; the entry registry keyed off `layout.ts`.

**Risks.** `.npmignore`-overrides-`.gitignore` (write both); rg/fd already skip `.noir/` (document `--hidden` behavior); monorepo per-workspace `.gitignore` + per-package `files` (Nx/Turborepo auto-append `.nx/`/`.turbo/` — same model).

---

### 4.4 Topic #4 — Integration skill system

**Requirement.** A first-class integration layer faithful to doctrine, Claude-first but multi-host-ready, composable with the skills compiler, and consistent with the locked decision: **skill-only by default, optional runtime tier only for genuinely stateful integrations**. Must generalize the proven ClickUp precedent (REST playbook + env auth + manual-paste fallback), declare auth/config per integration, support bi-directional SDD intake/wrap, and stay offline-testable.

**Precedent (from agentmemory).** The ClickUp integration shipped via DIRECT REST API *inside a skill* (not MCP): `GET https://api.clickup.com/api/v2/task/{id}`, `Authorization: pk_<token>`, env var auth, graceful manual-paste fallback, non-interactive-shell gotcha (must `source ~/.zshrc`). MCP was explicitly reserved. A backlog already scoped two-way sync (SP-6) and a standalone skill (SP-7).

**Architecture patterns compared.**

| Pattern | Pros | Cons | When | Fit |
|---|---|---|---|---|
| (a) Skill/prompt-only | zero runtime dep; portable; lazy; versionable as git artifacts; graceful degrade | no isolation; no long-lived state; agent re-derives retry/pagination; security = host tool-approval | stateless REST CRUD; simple key auth | **DEFAULT** |
| (b) Runtime adapter (bundle MCP) | process isolation + scoped tokens; central retry/rate-limit/GraphQL/pagination; OAuth/webhook state | heavy; harder multi-host; security burden moves into Noir; extra failure mode | OAuth2, webhooks, polling, heavy pagination | **OPTIONAL TIER** |
| (c) Config-only (point at external MCP) | lightest; shifts runtime off Noir; maximally portable | can't enforce auth; black box; no graceful degrade | high-quality first-party/community MCP exists | **emission target** |

**Decision framework (the crisp heuristic).** Start skill-only; escalate to runtime **only when state escapes a single REST call**: OAuth2/refresh (GitHub/Linear/Notion/Slack/Figma), webhooks/push, long-lived connections/polling, heavy pagination/GraphQL/rate-limits, secret rotation/least-privilege, cross-call state. Red Hat framing: *"Without MCP, the agent cannot access your systems. Without the skill, the agent has access but doesn't know your processes."*

**Recommendation.**
- **Structure:** `packages/skills/{ builtin/noir-*/, integrations/<name>/{SKILL.md, integration.json, references/*, [server/]} }`. Each integration = a skill + an `integration.json` declaration:

  ```json
  {
    "name": "noir-clickup",
    "auth": { "type": "env-var", "tokenEnv": "CLICKUP_API_TOKEN", "fallback": "manual-paste" },
    "runtime": "none",
    "sdd": { "intakeFrom": "task", "writeBack": ["status","subtasks"] },
    "mcp": null
  }
  ```
  For a stateful integration: `"runtime":"mcp-stdio"`, `"auth":{"type":"oauth2","scopes":[...]}`, `"mcp":{"command":"noir-integration-github","transport":"stdio"}`.
- **Compiler composition:** add `discoverIntegrations()` sibling to `discoverBuiltin()`; both feed a unified `BuiltinSkill[]`-shaped list (integrations share the `noir-` prefix + `SKILL.md` shape); validate `integration.json` (Zod) alongside `SKILL.md`; `CompileTarget` widens naturally with S10.
- **Ship in the SAME `@noir-ai/skills` pack, not a separate package.** A skill-only integration pulls *zero* deps (markdown). The only dep-weight problem is the optional runtime tier → make it an **optional peer / lazy dynamic `import()`** exactly as `@noir-ai/model` does for provider SDKs (import-isolation: a bundle that never selects an integration's runtime ships zero SDK bytes). Reserve a separate `@noir-ai/integration-<name>` only for native/heavy deps.
- **Config-only path** (`runtime: external-mcp`): the compiler emits the host-specific MCP config block (`.mcp.json` for Claude) alongside the playbook — no Noir runtime.
- **`integrations_auth` MCP tool (new):** resolves the env-var/keychain/OAuth token at call time so skills **never touch the shell directly** — this permanently kills the non-interactive-shell gotcha from the ClickUp precedent. Noir stores only the env-var *name* in config (mirrors S8's `apiKeyEnv`); reads the value at call time; never writes secrets into `.noir/` or the skill dir.
- **SDD two-way sync:** `noir-intake` reads `sdd.intakeFrom` (ClickUp task → intake stub); `noir-wrap`/`noir-document` call `sdd.writeBack` (status, subtasks, PR link). Skill playbook does REST for ClickUp today; runtime tier adds webhook real-time sync for Linear/GitHub (Linear↔GitHub bidirectional precedent).
- **Testing:** skill-only = `builtin-hygiene` pattern + contract test (declared endpoints match fixtures); runtime tier = `mcp-record` cassettes + contract testing + MockServer; **CI invariant: no real network** (mirrors S8 offline/free). OAuth = mock-oauth2-mcp-server for deterministic token-issue/refresh.

**Architecture impact.** `@noir-ai/skills`: `integrations/` sibling + `discoverIntegrations()` + `integration.json` Zod schema + emit host MCP config when `runtime∈{mcp-stdio,mcp-http,external-mcp}`. `@noir-ai/adapters`: `HostAdapter` gains optional `emitMcpConfig(integration, ctx)` (S10 — do it once). `@noir-ai/core`: new `integrations: {…}` config block. Daemon: new `integrations_auth` MCP tool.

**Risks.** Scope creep (default-deny; require an ADR per escalation); multi-host MCP-wiring divergence (abstraction lives in `HostAdapter`, not the integration); OAuth storage before keychain (refuse, or explicit opt-in to env-var — **do not silently lower the security bar**); skill prompt-injection (allowlisted endpoints + host tool-approval gate, documented in the integration's `SKILL.md`); versioning (`noirCompat` field); discovery UX (invisible until invoked — graceful-degradation doctrine).

#### 4.4.1 ClickUp — reference integration (concrete, locked 2026-07-25)

The first integration, fully specified. **All 5 flows feasible with the `pk_` personal token — no OAuth needed for ClickUp writes** (Q4b does not block it). Auth `Authorization: pk_<token>` (no Bearer), env `CLICKUP_API_TOKEN` resolved server-side via the `integrations_auth` MCP tool (kills the non-interactive-shell gotcha).

**Flows (verified ClickUp API v2):**
1. `GET /task/{id}` (numeric, or `?custom_task_ids=true&team_id=`) → bounded model drafts a PRD (**explicit opt-in**) + emits a task-detail md doc.
2. `PUT /task/{id} {status}` — `status` is a system field; valid values from the list's statuses.
3. `POST /list/{list_id}/task {name, parent}` (subtask; parent in same list) + `PUT /task/{subtask_id} {status}`.
4. `POST /task/{id}/comment {comment_text, notify_all, assignee?}`.
5. Batch create — **no bulk endpoint** → loop `POST /list/{list_id}/task` (concurrency cap 4-8 + 429 backoff reading `X-RateLimit-Reset`). Input = **H2-per-task markdown template** (+ CSV adapter); dry-run preview table → **explicit confirm** → POST. **Read path = user exports Google Docs → Markdown (no OAuth); "read via Docs URL" deferred to v1.x keychain unlock** (Q4b).

**Tier-model refinement (from ClickUp, Q-ClickUp 2):** integrations span THREE tiers —
- **skill-only** (reads + playbook; agent calls REST directly);
- **skill + gated write-proxy MCP tool** (stateless writes routed through a Noir tool like `noir.clickup_write` / generic `integrations_call` that enforces a dry-run→confirm gate + audit) — for write-heavy stateless integrations like ClickUp; NOT a full runtime (no OAuth/webhook/polling);
- **full runtime tier** (stateful: OAuth/webhook/polling) — gated on keychain.

`integration.json` gains `runtime: 'none' | 'gated-write-proxy' | 'mcp-stdio' | 'external-mcp'`; ClickUp = `gated-write-proxy`. (Reads + the playbook remain skill-side; only writes go through the gated tool.)

**PRD-from-task mapping (flow 1, explicit opt-in):** name→Title; description→Problem/Proposed Direction; custom_fields (Goal/Metric/Impact)→Evidence/Success Criteria; status+priority→Appetite/Mode; assignees→Audience; due_date→time-box; tags→clustering; comments→Open Questions/Rabbit holes; subtasks→Proposed Direction skeleton. Model runs a clarifying-Q pass for typically-missing No-gos / hard Success-Criteria metrics / explicit Rabbit holes.

**Verify-live before lock-in (runtime, not blockers):** (i) whether `GET /list/{id}` returns a usable `statuses` array (no dedicated endpoint; community-attested) — fallback: probe tasks / attempt-and-handle-400; (ii) tag auto-create vs 400 (ClickApp-dependent) — runtime check + "create missing tag?" prompt.

**Config (one workspace binding):** `CLICKUP_API_TOKEN` (env), `team_id`, default `list_id`, optional `space_id`.

---

### 4.5 Topic #5 — Intelligent project scaffolding (AI-layer)

**Requirement.** `noir init` must (a) **own the AI foundation** (`.noir/` + AI artifacts + host wiring + ignore), (b) **compose, not compete** with code scaffolders, (c) **attach cleanly to an existing project** (fill gaps, never overwrite), be re-runnable/upgradeable across Noir versions, multi-host-ready, and `--no-input`-friendly for CI.

**AI-friendly-repo findings (what maximizes discoverability).** (1) One canonical context file at root that the agent reads first (`AGENTS.md` standard; Claude reads `CLAUDE.md` and `@import`s/links `AGENTS.md`). (2) Up-tree discovery, nearest-wins. (3) Repo-as-context via a ranked symbol map (Aider: tree-sitter AST + dep graph + PageRank → token-budgeted symbol index). (4) README-first + code-as-docs (Repomix). (5) Conventional, predictable paths for specs/plans/decisions/tasks (Spec Kit `specs/[branch]/`; MADR `docs/decisions/NNNN-*.md`). ⚠️ **Caveat:** one empirical study found repo-level context files can *reduce* agent success while raising cost if they're noise (Hackernoon) — **quality and placement matter more than volume**.

**Scaffold-engine patterns compared.**

| Pattern | Upgradeable? | Fit for Noir's AI-layer |
|---|---|---|
| **Copier** (answers-stamp + smart-diff + `skip_if_exists`) | first-class | **strongest** — borrow answers-stamp + smart-diff + skip-if-exists verbatim |
| Yeoman (mem-fs Conflicter) | partial, awkward | **reject** — interactive conflict blocks CI |
| Cookiecutter | no | reject |
| **Plop/Hygen** (add/modify/append marker actions) | manual | **borrow the action model** for marker-block idempotent edits |
| **Nx/Angular** (migrations.json schematics) | yes (code) | **borrow the migrations-manifest idea**, not the machinery |
| create-t3/Vite/create-turbo | no (one-shot) | these are what Noir *composes with* |
| **shadcn CLI** (`init` for existing projects) | per-component | **closest analogue** for "attach to existing project, fill-gap" |

**Recommendation.** A hand-rolled **Copier-shaped core** + **Plop-style marker-block actions** + **Nx-style `scaffold-version` + migrations manifest** — no external scaffold runtime dependency (each pulls a Python/Node ecosystem Noir shouldn't own).

- **Three write-modes per artifact** (declarative in a scaffold manifest):
  - `regenerate` — pure pointers: `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, `.claude/skills/noir-*`. Always overwritten from `.noir/`.
  - `managed_block` — co-owned files: `NOIR.md` auto-brief, `.gitignore`'s `# noir managed` block, `README.md` AI-section pointer. Re-emitted idempotently; user edits outside markers preserved.
  - `skip_if_exists` — user-owned templates: `prd.md` (seed), `roadmap.md`, ADR skeleton, `config.yml`. Init writes the seed once; later runs **never** overwrite.
- **`.noir/scaffold-version`** — `noir-scaffold=1.0.0`; bumped atomically per scaffold-changing release (Copier's `.copier-answers.yml` "last-applied" stamp, simplified).
- **`noir init --upgrade` flow:** read `scaffold-version` → diff vs current → run declarative migration list (`migrations/<from>-<to>.mjs`, small idempotent scripts) → re-emit `regenerate`+`managed_block` → leave `skip_if_exists` alone → on managed-block conflict, **fall back to inline conflict markers** (Copier default) so `--no-input` CI survives (never Yeoman interactive prompts).
- **`.noir/` workspace = HYBRID** (recommended): `.noir/` = canonical store; root = thin conventional pointers (`CLAUDE.md`, `AGENTS.md`, `README.md`, `.mcp.json`, `.gitignore`, `.gitattributes`) regenerated from `.noir/`. This is the canonical-source + host-@import pattern Noir already uses. Portable (delete `.noir/` → host files become inert pointers; delete host files → Noir re-emits), multi-host, scalable, CI/Git-friendly.
- **Composition (shadcn model):** `init` is explicitly designed for the existing-project path. Stack-detect (read-only, never assume): `package.json`/workspaces, `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, framework markers. Surface in onboarding TUI; user confirms. Monorepo → AI layer at workspace root; per-package pointers opt-in. **Fill-gap, never overwrite** (the predecessor `ai-dev-workflow /init` "detect-then-fill" mode is the right template, generalized from docs to the full AI layer). For greenfield: document `pnpm create vite . && noir init` order; **never wrap** external scaffolders (locked decision).
- **Three-phase `noir init`:** Detect (read-only) → Confirm (`@clack/prompts`, already a Noir dep; `--no-input` skips) → Emit (idempotent, three-mode).

**What `noir init` should generate (matrix).** `CLAUDE.md`/`AGENTS.md`/`README.md`/`.mcp.json` (regenerate, pointers); `.noir/{NOIR.md, config.yml, project.id, scaffold-version}` (managed/skip); `.noir/{specs,plans,tasks,decisions(prd,roadmap,CHANGELOG)}` seeds (skip_if_exists); `.gitignore`/`.npmignore`/`.dockerignore`/`.prettierignore` managed blocks; CI templates (opt-in); `.noir/store/*.db`/`state/` (gitignore). (Full table in §4.5 of the per-topic detail.)

**⚠️ Correction to the research agent's assumption.** The agent recommended "extend `@noir-ai/create`." **That package does not exist** — verified: `packages/` = 10 only (adapters, cli, context, core, daemon, memory, model, skills, store, workflow); the only `templates/` dir is `packages/memory/templates`. Scaffolding today lives in `@noir-ai/cli` (`init.ts` + `sync.ts`). **✅ Resolved (2026-07-25, Q5a): extract a NEW `@noir-ai/create` package** holding `manifest.ts`/`templates/`/`migrations/`/`writers.ts`. Rationale: cleaner boundaries, testable in isolation, reusable by `init`/`sync`/`doctor`; matches the `@noir-ai/skills` precedent (compiler in its own package though only consumed by init/sync). `init`/`sync`/`doctor` in `cli` become thin callers of the shared writer. **(Q5e, 2026-07-25)** the package also exposes a `bin`, invokable as `npm create noir-ai` for **greenfield first-run** (no install) — distinct from `noir init` (attach/re-run/`--upgrade`). AI-layer only in both; code structure still comes from external scaffolders (composed, never wrapped).

**Architecture impact.** Scaffold engine = `manifest.ts` (declarative artifact table) + `templates/` (markdown/yaml/json) + `migrations/` (versioned scripts) + `writers.ts` (the three-mode writer, generalizing `replaceBlock()`). `scaffold-version` read on every `init`/`doctor`. `noir sync` = the lighter runtime version of the same writer (host-side artifacts + managed blocks only) — **extract the shared writer early** so `init`/`sync` don't diverge. The bounded model (S8) can draft-fill `prd.md` / initial spec skeletons on first init when a provider is configured (no key → empty template).

**Risks.** Marker-block portability (HTML-comment in md, `#` in gitignore, none in TOML — need a per-file-type marker vocabulary; `doctor` warns on malformed markers); conflict-marker fatigue (inline `<<<<<<<` may confuse AI agents — prefer `skip_if_exists` over `managed_block` wherever possible); monorepo per-package `AGENTS.md` noise; `AGENTS.md`↔`CLAUDE.md` drift (symlink Unix / @import Windows; `doctor` diff-check); scaffold-version drift across branches (guidance: `noir init --upgrade` after merge); template-language choice (lean hand-rolled `{{var}}` over a mustache dep, given how simple Noir's markdown templates are).

---

## 5. Consolidated architecture impact (cross-topic)

**Verified current state.** `@noir-ai/core/markers.ts` (CONTEXT_BLOCK_BEGIN/END) + `init.ts:replaceBlock()` already implement managed-block regeneration for `CLAUDE.md`. Skills compiler (`discoverBuiltin/parseFrontmatter/validateSkill/compileSkill/emitSkillsToDir`, `CompileTarget='claude'`, `FORBIDDEN_RESIDUE`) is the canonical→host compiler today. `HostAdapter` (`emitMcpConfig/emitContext/skillsDir?/install?/healthCheck?`) + `McpConfigOptions` + `EmitContext` are in `@noir-ai/adapters`. `layout.ts` knows specs/plans/tasks/decisions/audit/store but **not** prd/rules/user-skills/scaffold-version. `noir init` is thin; `noir sync` re-emits skills only.

**Required changes (consolidated, by package).**

| Package | Change |
|---|---|
| `@noir-ai/core` | generalize `markers.ts` (multi-marker: add `IGNORE_BLOCK_*`, per-file-type sentinels); generalize `replaceBlock()` into a shared managed-block writer; add `prdDir`/`rulesDir`/user-`skillsDir`/`scaffoldVersion` to `layout.ts`; add `IgnoreManager` (declarative registry + `syncIgnores`); config blocks: `rules`, `integrations`, `prd`, (scaffold manifest) |
| `@noir-ai/skills` | generalize compiler into shared "canonical→host artifact compiler"; `integrations/` sibling + `discoverIntegrations()` + `integration.json` Zod schema; widen emit for host MCP config; `CompileTarget` widens with S10 |
| `@noir-ai/adapters` | `HostAdapter.emitRules(ctx)`; optional `emitMcpConfig(integration, ctx)` for integration MCP (S10) |
| `@noir-ai/workflow` | `prd` artifact kind; soft escapable gate predicate on `taskClass`; `writePrd/readPrd` |
| `@noir-ai/model` | `draftPrd(intake, clarify, memory)` (offline → template) |
| daemon | `integrations_auth` MCP tool |
| `@noir-ai/cli` (or new `@noir-ai/create`) | scaffold engine: `manifest.ts`/`templates/`/`migrations/`/`writers.ts`; three-mode writer; stack-detect; `noir init --upgrade`; shared writer extracted for `init`/`sync`/`doctor` |
| builtin skills | add `noir-prd`, `noir-rules` |
| `noir doctor` | checks: @import resolves, RULES.md under budget, managed markers well-formed, ignore efficacy (`git check-ignore`, `npm pack --dry-run`), scaffold-version drift |

**Backward compatibility.** All additions are additive (new config blocks default to absent → degraded; new artifact kinds optional; managed blocks additive). Existing `noir init` behavior is preserved; the three-mode writer is a strict superset of today's `replaceBlock()`.

---

## 6. Risks & mitigations (consolidated)

| Risk | Mitigation |
|---|---|
| Managed-block markers malformed/edited by user | `noir doctor` warns; only complete marker pairs rewritten; per-file-type sentinels |
| Conflict markers (`<<<<<<<`) confuse AI agents | prefer `skip_if_exists` over `managed_block`; reserve `managed_block` for genuinely co-owned files |
| Rules length drift → token bloat | hard budget (≤150 lines/6 KB); `doctor` flags + proposes trims; pruning rubric (failure-backed OR tool-enforceable OR decision OR trigger) |
| Rules contradict host system prompt → "constraint-evasive fabrication" | phrase positively; test against the real Claude system prompt; non-overlapping scopes across `AGENTS.md` + `.cursor/rules` |
| PRD↔spec drift | `prdRef: <id>@<hash>` + `noir verify` stale check |
| Hallucinated PRD requirements | mandatory grounding step; Open Questions section; never fill "Evidence" without a source |
| Integration scope creep | default-deny runtime tier; ADR required per escalation; crisp state-escape heuristic |
| OAuth token storage before keychain | refuse OAuth integrations until keychain, OR explicit opt-in to env-var with warning — never silently lower the security bar |
| Skill prompt-injection (malicious issue-tracker response) | allowlisted endpoints in playbook + host tool-approval gate; documented in integration `SKILL.md` |
| `@import` Claude-specific → multi-host inconsistency | inline at draft time for non-@import hosts (HostAdapter/S10) |
| `AGENTS.md`↔`CLAUDE.md` drift | symlink Unix / @import shim Windows; `doctor` diff-check |
| `init`/`sync` writer divergence | extract shared `writers.ts` early |
| `@noir-ai/create` assumed to exist (it doesn't) | decide: build in `cli` vs new `create` package (§9) |
| Repo-level context files can *reduce* agent success if noise | quality > volume; short canonical `NOIR.md` + `RULES.md`; pointers not bodies |

---

## 7. Open clarification questions (grouped)

**Cross-cutting / roadmap**
- Q0a. Package these as sequential v1.1→v1.x slices (recommended), or one v1.x milestone?
- Q0b. Slice numbering: S12+ (new), or fold into existing S10/S11?

**T1 PRD**
- Q1a. `mandatoryFor` default list = `[feature, epic]` only, or include `enhancement`?
- Q1b. PRD approval = its own observable gate (recorded to audit), or just a soft prompt before `spec`?
- Q1c. Machine-verifiable success criteria — enforced format (lint), or advisory?

**T2 Rules**
- Q2a. Canonical = single `.noir/rules/RULES.md`, or per-topic `.noir/rules/*.md` (feeds Cursor `.mdc` compilation natively)? (affects length budget + compiler)
- Q2b. Emit a root `AGENTS.md` now (Claude-first but forward-compatible) or only `CLAUDE.md` until S10?
- Q2c. Ship a Noir-curated `RULES.md` seed (with the anti-assumption/SDD contract pre-filled), or an empty template?

**T3 Ignore**
- Q3a. Defaults for user-choice items: commit `audit/`? commit `mcp/manifest`+`adapters/` (derived)?
- Q3b. Manage `.npmignore`/`files` for *user* packages, or only Noir's own 10?
- Q3c. ESLint flat `ignores` / VS Code `settings.json`: advisory + doctor only (recommended), or attempt managed-block?

**T4 Integration**
- Q4a. First integration to ship: generalize ClickUp (skill-only + two-way sync SP-6), or GitHub (via MCP), or both?
- Q4b. Before keychain lands: refuse OAuth integrations, or allow env-var opt-in with explicit warning?
- Q4c. Runtime-tier integrations: same `@noir-ai/skills` pack (optional peer/dynamic import — recommended), or separate `@noir-ai/integration-<name>` packages from the start?

**T5 Scaffold**
- Q5a. **Build scaffold engine in `@noir-ai/cli`, or extract a NEW `@noir-ai/create` package?** (keystone decision)
- Q5b. Stack-detection scope: Claude-host projects only, or broad (Node/Python/Go/Rust for ignore + path adaptation)?
- Q5c. Template language: hand-rolled `{{var}}` (recommended) vs a mustache dep?
- Q5d. Monorepo: per-package `AGENTS.md` by default, opt-in, or workspace-root only?

---

## 8. Blueprint per topic (one-paragraph design)

- **T1 PRD.** `.noir/prd/<id>-<slug>.md` artifact (9 sections), `taskClass`-gated mandatory, feeds spec via `@import` + `prdRef@hash`; bounded model drafts it grounding-first; `noir-prd` skill; soft escapable gate in `advance()`; no FSM change.
- **T2 Rules.** `.noir/rules/RULES.md` canonical (≤150 lines) + `emitRules()` on HostAdapter; Claude = one-line managed `@import` in `CLAUDE.md` (composes with `NOIR.md`); `AGENTS.md`/Cursor `.mdc` emission at S10; `RULES.local.md` for user extensions; `noir-rules` skill + `doctor` budget check.
- **T3 Ignore.** `IgnoreManager` + `IGNORE_BLOCK` markers (reuse the proven managed-block primitive); declarative registry keyed off `layout.ts`; hook into `init`/`sync`; advisory + `doctor` for non-editable configs; commit markdown source, ignore derived DB.
- **T4 Integration.** `skills/integrations/<name>/{SKILL.md,integration.json}` + compiler extension; skill-only default, runtime tier only when state escapes a REST call; `integrations_auth` MCP tool (kills the shell gotcha); SDD two-way via `sdd.intakeFrom`/`sdd.writeBack`; offline cassettes in CI; same skills pack (import-isolation for runtime deps).
- **T5 Scaffold.** Three-mode writer (`regenerate`/`managed_block`/`skip_if_exists`) generalizing `replaceBlock()`; `.noir/scaffold-version` + migrations manifest; HYBRID workspace (`.noir/` canonical + thin root pointers); shadcn-style attach-to-existing/stack-detect/fill-gap; `init`/`sync`/`doctor` share the writer; compose with external scaffolders, never wrap.

---

## 9. Implementation roadmap recommendation (sequencing)

The keystone (K) unblocks all five; then order by dependency + leverage:

| Slice | Capability | Why this order |
|---|---|---|
| **K** | **Keystone refactor** — shared managed-block writer (generalize `replaceBlock`), extract shared "canonical→host artifact compiler" from skills, extend `HostAdapter` (`emitRules` + integration-aware `emitMcpConfig`) | every later slice depends on it; smallest blast radius; pure refactor, no behavior change |
| **R** | **Rules** (Claude-first) | highest leverage (the AI contract story); first emitter on the new foundation; ships before S10 (Claude-only) |
| **I** | **Ignore management** | self-contained; second use of the managed-block writer; immediate hygiene win |
| **P** | **PRD** (workflow artifact kind + `noir-prd` + `draftPrd`) | adds the lifecycle artifact; depends on scaffold seeds (prd/ template) → after scaffold OR co-developed |
| **S** | **Intelligent scaffold** (three-mode writer + manifest + migrations + stack-detect) | the *container* that orchestrates R/I/P seeds at init/sync; biggest slice; benefits from R/I/P emitters existing first |
| **X** | **Integration skills** (compiler extension + `integration.json` + `integrations_auth` + first integration) | most optional; runtime tier is explicitly opt-in; Claude-first, multi-host at S10 |

> **Two viable orderings:** (a) K→R→I→P→S→X (emitters first, scaffold last as container); (b) K→S→R→I→P→X (scaffold first so it hosts all seeds). Recommended: **(a)** — build the small emitters, prove the pattern, then let the scaffold engine orchestrate them. Scaffold-first risks building a container before its contents are stable.
>
> **✅ Locked (Q0a, 2026-07-25): sequential slices S12+** as a v1.1→v1.x series (not a single bundled milestone), ordering (a) K→Rules→Ignore→PRD→Scaffold→Integration.
>
> Each slice follows Noir's dogfooded SDD cadence (brainstorm→spec→plan→subagent-driven implement+review→main-loop validates `pnpm build/lint/typecheck/test`→opus whole-branch review→docs/memory checkpoint→local commit). Slices R/I/P/X are Claude-first; their multi-host emission arrives with S10.

---

## 10. Final recommendation + rationale

**Build the keystone (K) first, then deliver the five capabilities as incremental extensions of Noir's existing canonical-source + host-emit + managed-block triad.** This is the recommendation because:

1. **It is faithful to verified architecture.** The marker primitive and managed-block writer already exist and already drive `CLAUDE.md`. The skills compiler is already a canonical→host compiler. `HostAdapter` already abstracts emission. Every recommendation reuses these — none invents a parallel mechanism.
2. **It honors the locked scope decisions.** AI-layer-only scaffold (no Nx-competition); v1.x Claude-first (multi-host-ready by design, shipped Claude-only); skill-default integrations (ClickUp precedent generalized, runtime tier opt-in); PRD as a pre-SDD artifact (no FSM change).
3. **It honors the §9 doctrine.** Each idea (Copier upgrade-story, Plop marker-actions, Kiro artifact-feeding, Claude's own AGENTS.md @import guidance, the ClickUp skill-only integration) is adopted as a *native Noir design* — no copies, no ALL-CAPS rhetoric, graceful degradation throughout (no key → template; daemon down → direct; missing integration token → manual-paste).
4. **It is sequenced for leverage + low risk.** The keystone is a pure refactor; Rules is the highest-leverage, smallest slice; the scaffold container lands last, after its contents are proven; integration runtime is opt-in and can wait for the keychain.
5. **It resolves the one error found in research.** `@noir-ai/create` does not exist — the scaffold engine is a new package (or built in `cli`), a decision deferred to Q5a.

**The five ideas are not five features — they are one mechanism, five times.** Recognizing that collapses perceived scope and produces a coherent, maintainable v1.x.

---

## 11. References (verified primary sources)

**Spec-driven / PRD:** GitHub Spec Kit (github.com/github/spec-kit, spec-driven.md) · AWS Kiro (kiro.dev/docs/specs, feature-specs) · Gemini CLI SDD · Shape Up (basecamp.com/shapeup) · Amazon Working Backwards PR/FAQ · Haberlah "PRDs for AI Coding Agents" · Atlassian/Lenny PRD templates · Augment Code SDD guide.

**Rules / AI context:** agents.md · Claude Code memory docs (code.claude.com/docs/en/memory) · Cursor rules (cursor.com/docs/rules) · Codex AGENTS.md · GEMINI.md · Continue rules · Cline rules · Aider conventions · Copilot instructions · Windsurf rules · rulesync · ai-rules-sync · wordman "Agent Instructions" · Hackernoon "Evaluating AGENTS.md".

**Ignore / packaging:** git gitignore docs · npm `files`/`publish`/`.npmignore` precedence · Docker `.dockerignore` · ripgrep GUIDE + `.ignore` semantics · ESLint flat config · Prettier ignore · SonarQube analysis scope · CodeQL config · Dependabot config · projen `IgnoreFile` · Ruler managed-block (#600) · Nx/Turborepo gitignore · nesbitt "Many Flavors of Ignore Files".

**Integration / MCP:** Claude Code MCP + Skills · agentskills.io · VS Code `.vscode/mcp.json` · Cline MCP · Roo `.roo/mcp.json` · Goose extensions · Continue config · Zed extensions + context_servers · Cursor rules · Aider repomap/conventions · MCP build-server + state discussion · WorkOS MCP secrets best-practices + MCP-vs-REST · Red Hat "MCP servers vs Skills" · FastMCP GitHub OAuth · mcp-record · MCP contract testing · MockServer · BerriAI mock-oauth2-mcp-server · Linear↔GitHub bidirectional.

**Scaffolding:** Copier (updating, configuring, comparisons) · Yeoman file-system + Conflicter · Plop.js · Nx migrate · Angular ng-update schematics · create-t3-app · shadcn CLI + components.json · Repomix · MADR · actions-template-sync.

**Noir internal (grounding):** `docs/internal/specs/2026-07-23-noir-toolkit-design.md` · `docs/roadmap/` · `packages/core/src/{markers.ts, layout.ts, config.ts}` · `packages/skills/src/{types.ts, discover.ts, compiler.ts, residue.ts}` · `packages/adapters/src/{types.ts, claude.ts}` · `packages/cli/src/{init.ts, sync.ts}`.
