# Slice S10 — Multi-host adapters (+ S11 SDK remainder) — design spec

> v1.x capability slice (session 2). Companion: `docs/internal/specs/2026-07-25-v1x-capabilities-design.md` §4.2 (Rules research) + §4.4 (Integration/host MCP). **Status: NOT started.** This spec is the implementation reference; the plan + execution follow.
> **Clarification APPROVED 2026-07-25 ("approve all"):** A1 (registry + `agents-md` + `gemini` + `cursor` + `opencode`; defer qwen/agy), B1–B4 (registry + config/CompileTarget widen + CLI refactor), C1–C4 (universal AGENTS.md + per-host skill/MCP + single-host select), D1–D2 (sdk docs + doctor publish check), E1 (release as `1.2.0-beta.1`).

## Goal
Make Noir **cross-CLI**: any supported agentic CLI can be the host, selected by `config.host`. Noir owns the `.noir/` canonical store + emits host-facing artifacts (context / rules / skills / MCP config) in each host's native format. Claude remains the default; existing single-host projects are unchanged.

## Key research finding (2026-07)
**AGENTS.md is now the cross-tool standard — 32+ platforms read it natively** (Claude Code, OpenAI Codex, Cursor, Gemini CLI, JetBrains Junie, …). This collapses S10 from "5 bespoke adapters" to **one universal AGENTS.md emitter + specialized emitters for hosts that need format-specific features**. Verified current formats:
- **AGENTS.md** (universal): root `AGENTS.md`; context+rules unified; native to ~32 platforms.
- **Cursor**: `.cursor/rules/*.mdc` (YAML frontmatter `description`/`globs`/`alwaysApply`); legacy `.cursorrules` deprecated; Cursor ALSO reads `AGENTS.md`. MCP at `.cursor/mcp.json` (or `~/.cursor/mcp.json`), shape `{mcpServers}`.
- **Gemini CLI**: `GEMINI.md` context; `@path/to/file.md` import syntax; reads `AGENTS.md`. MCP at `.gemini/mcp.json` (or `~/.gemini/`).
- **OpenCode**: `AGENTS.md` + custom agents (`opencode.json`); MCP via `opencode.json` `mcp` block.
- **Claude** (existing): `CLAUDE.md` @import; `.claude/skills/`; `.mcp.json`.

## Locked decisions (A1–E1)
- **Adapters shipped:** `claude` (existing) + `agents-md` (NEW universal) + `gemini` + `cursor` + `opencode`. **qwen/agy deferred** (lower priority; `agents-md` covers them).
- **`resolveAdapter(host)` registry** in `@noir-ai/adapters`; CLI selects via `config.host`.
- **`host:` config** widens from `z.literal('claude')` → `z.enum(['claude','agents-md','gemini','cursor','opencode'])`; `claude` is default.
- **`CompileTarget`** widens to the same enum; compiler transforms per-host (e.g. skill → Cursor `.mdc`).
- **CLI refactor:** the 8 direct `claudeAdapter` imports (init/sync/create) → `resolveAdapter(host)`.
- **AGENTS.md universal:** always emit a root `AGENTS.md` that `@`-imports `.noir/NOIR.md` + `.noir/rules/RULES.md` — for EVERY host, as the canonical base (32-platform standard). Claude additionally keeps `CLAUDE.md` @import.
- **Skills for non-Claude:** Cursor compiles skills → `.cursor/rules/*.mdc`; `gemini`/`opencode`/`agents-md` have no skill concept → no skill dir (the AGENTS.md/GEMINI.md context is the surface; `noir skills list` remains available).
- **MCP config per-host:** emit the host's MCP file (`.mcp.json` / `.cursor/mcp.json` / `.gemini/mcp.json` / `.vscode/mcp.json`), same `{mcpServers}` shape.
- **Single-host select for v1.x:** `host:` selects ONE primary host (+ always-AGENTS.md). Multi-host `hosts:[...]` emit = future.
- **S11 remainder:** ship `docs/sdk.md` (per-package public API — "usable as a framework") + a `noir doctor` `publish` check (publish-metadata validation across packages).
- **Release:** `1.2.0-beta.1`.

## Architecture

### Registry + config + compiler widening (the foundation)
- `packages/adapters/src/index.ts`: export `resolveAdapter(host: HostId): HostAdapter` — a `Record<HostId, HostAdapter>` map. Unknown host → throw a clear error (or fall back to `agents-md`). Export `HostId` type + `SUPPORTED_HOSTS`.
- `packages/adapters/src/types.ts`: `HostAdapter.id: HostId`. Add an optional `emitAgentsMd?(ctx): string` seam (the universal emitter) OR make AGENTS.md emission a shared helper all adapters compose. **Decision:** a shared `emitAgentsMd(ctx)` helper in adapters (not per-adapter) — every host gets the SAME AGENTS.md content (canonical `@`-imports); per-adapter specialization is for the host's OWN native files. This keeps AGENTS.md byte-identical across hosts (single source of truth).
- `packages/core/src/config.ts`: `host: z.enum(['claude','agents-md','gemini','cursor','opencode']).default('claude')`.
- `packages/skills/src/types.ts`: `CompileTarget = HostId`. `packages/skills/src/compiler.ts`: `compileSkill(skill, target)` transforms per target — `claude`/`agents-md`/`gemini`/`opencode` = verbatim SKILL.md (no skill dir emitted for non-Claude; see emit logic); `cursor` = compile to `.mdc` (frontmatter `description` ← skill description, `alwaysApply: false`, body ← SKILL.md body). The emit STEP decides WHERE skills go (Claude → `.claude/skills/`; Cursor → `.cursor/rules/`; others → skip).

### Per-adapter emission contract
Each adapter implements `HostAdapter`. Emission targets (per the three-mode scaffold + the cli's `scaffold()`/`sync()`):

| Adapter | Context file | Rules | Skills dir | MCP config file |
|---|---|---|---|---|
| `claude` (existing) | `CLAUDE.md` (CONTEXT_BLOCK + RULES_BLOCK @import) | in CLAUDE.md | `.claude/skills/` | `.mcp.json` |
| `agents-md` | `AGENTS.md` (@import NOIR.md + RULES.md) | in AGENTS.md | — (none) | — (or `.mcp.json`) |
| `gemini` | `GEMINI.md` (@import NOIR.md + RULES.md) + root `AGENTS.md` | in GEMINI.md | — | `.gemini/mcp.json` |
| `cursor` | `AGENTS.md` + `.cursor/rules/general.mdc` (noir rules) | `.cursor/rules/*.mdc` | `.cursor/rules/` (skills→.mdc) | `.cursor/mcp.json` |
| `opencode` | `AGENTS.md` | in AGENTS.md | — | `opencode.json` (mcp block) |

- **AGENTS.md content (universal, shared helper):** `# <project> — Noir context\n\n@.noir/NOIR.md\n@.noir/rules/RULES.md\n` (AGENTS.md-native hosts read these imports). For Claude, AGENTS.md is ALSO emitted (Claude reads it) but CLAUDE.md remains the primary.
- **MCP config shape:** all hosts use `{ "mcpServers": { "noir": {command:"noir", args:["mcp","serve","--stdio"]} } }` (stdio) or `{type:"http",url}`. The adapter writes it to the host's path. Existing `emitMcpConfig(ctx,opts,integration?)` returns the JSON STRING; the cli/`@noir-ai/create` writes it to the host-specific path. So adapters gain a `mcpConfigPath(ctx): string` (or the cli derives it from `host`).

### CLI refactor (`packages/cli`)
- Replace `import { claudeAdapter }` in `init.ts`/`sync.ts`/`create.ts` with `resolveAdapter(host)` where `host` comes from the resolved config (or `--host` flag, default `claude`).
- `noir init`/`create`/`sync` gain a `--host <id>` flag (default `claude`); the chosen host drives emission.
- `@noir-ai/create` manifest/scaffold becomes host-aware: the manifest entries' `host` tag + the adapter's emission paths drive what gets written. (The manifest already has a `host?: 'claude` field — widen to `HostId`; the orchestrator filters by the resolved host + adds host-specific entries via the adapter.)
- `noir doctor`: report the active host; verify host-specific artifacts exist.

### S11 remainder
- **`docs/sdk.md`:** "Using Noir as a framework/library" — the public, stable API surface per package: `@noir-ai/core` (config schema, layout/paths, markers/managedBlock), `@noir-ai/store` (openStore, searchFt, knn, KV), `@noir-ai/workflow` (WorkflowEngine, advance/startTask/resumeTask, gates), `@noir-ai/adapters` (HostAdapter, resolveAdapter), `@noir-ai/skills` (compileSkill/emitSkillsToDir/discoverAll), `@noir-ai/context` (ContextEngine, retriever), `@noir-ai/memory` (MemoryEngine, save/recall), `@noir-ai/model` (complete, draftPrd). Versioning + stability stance.
- **`noir doctor` `publish` check:** validate every `packages/*/package.json` has `name` (`@noir-ai/*`), `version` (semver), non-empty `files`, and (for `cli`) a `bin`; optionally run `npm pack --dry-run` on the cli + report the file count / any missing `dist`. `warn` (never `fail`) — advisory.

## Acceptance
- `resolveAdapter('claude'|'agents-md'|'gemini'|'cursor'|'opencode')` returns a working adapter; unknown host throws clearly.
- `noir init --host gemini` produces `GEMINI.md` + `AGENTS.md` + `.gemini/mcp.json` + `.noir/`; `--host cursor` produces `AGENTS.md` + `.cursor/rules/*.mdc` (incl. noir rules + skills-as-.mdc) + `.cursor/mcp.json`; `--host opencode` produces `AGENTS.md` + `opencode.json`; `--host agents-md` produces `AGENTS.md` (+ `.mcp.json`).
- Default `noir init` (claude) is byte-equivalent to today (no regression — the existing init/skills/doctor tests stay green).
- `host:` config validated; `noir doctor` reports the active host + host artifacts.
- `docs/sdk.md` ships; `noir doctor` `publish` check runs.
- All 966+ tests green; new tests per adapter (emission shape, registry, config enum, cursor .mdc transform, cli `--host`); 0 lint warnings; build/typecheck green.

## Risks
- **AGENTS.md @import semantics differ per host** (Claude/Gemini support `@import`/`@file`; some AGENTS.md readers may not resolve `@`-imports). Mitigation: AGENTS.md carries the `@`-import lines AND a short inline fallback summary; document per-host behavior.
- **Cursor `.mdc` skill transform** loses Claude-specific skill semantics (references/, progressive disclosure). Mitigation: emit a `.mdc` per skill with the body; references inlined or skipped (documented).
- **MCP config path discovery** per host (global vs workspace). Mitigation: emit WORKSPACE-level files (project-local) — the portable choice; document global alternatives.
- **Scope creep** — 4 adapters + registry + compiler + cli refactor is large. Mitigation: ship foundation + 4 adapters to production quality; if time-bound, a clean checkpoint with completed adapters + others marked "registry-ready, next slice" (per the user's failure principle).

## Open (low-stakes, default in plan)
- Cursor skill `.mdc` `alwaysApply`: `false` (agent-decided via `description`) — confirmed.
- OpenCode `opencode.json` MCP shape — confirm against opencode.ai docs during implementation.
- `agents-md` MCP config: emit `.mcp.json` (Claude-shape, broadly compatible) or none — lean: emit `.mcp.json` (harmless; many AGENTS.md hosts also read it).
