# Noir — S5 Builtin Skills + Compiler Design (`@noir-ai/skills`)

- **Date:** 2026-07-24
- **Status:** Reviewed (2026-07-24) — OQ-1…OQ-4 resolved (see §8); ready for implementation planning.
- **Parent:** blueprint §6.4 (skill system) + §9.1 (description=WHEN, observable checkpoint) + the delivered S4 engine
- **Slice:** S5 — roadmap v1.0. Depends on `@noir-ai/core` + `@noir-ai/adapters` (the host emitter).

---

## 0. TL;DR

The **Noir skill pack** — the SDD lifecycle + power skills as canonical `SKILL.md` files, all **`noir-` prefixed**, with a compiler that emits them to the host (Claude Code first). Skills are **playbooks loaded on demand** by the host; discipline comes from the **S4 engine's observable gates** (§9.1), not from the skills themselves. The key authoring rule: **`description` = WHEN to trigger, never WHAT it does** (§9.1 / [Anthropic best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)).

---

## 1. Goals & scope

### 1.1 In scope
- `@noir-ai/skills` package: canonical SKILL.md files (the builtin pack) + a compiler/emitter.
- **Builtin pack** (all `noir-` prefixed): SDD lifecycle — `noir-intake`, `noir-clarify`, `noir-spec`, `noir-plan`, `noir-execute`, `noir-verify`, `noir-document`, `noir-checkpoint`, `noir-sync`; power skills — `noir-brainstorm`, `noir-debug`, `noir-review`.
- **Compiler**: canonical SKILL.md → host-native (Claude copies to `.claude/skills/`; other hosts later via the adapter's emitter).
- **Integration**: the claude adapter emits skills via the compiler; `noir init`/`noir sync` triggers the emit.
- **Source material**: the rebranded predecessor plugin (`plugins/noir-workflow/`) provides proven skill content (reused as canonical source — blueprint §1).

### 1.2 Out of scope
- **Non-Claude hosts** (Gemini/OpenCode/Qwen emitters) — v1.x (S10).
- **The SDD engine integration** (skills REFERENCE the engine's phases/gates but the engine itself is S4 — already done).
- **Skill enforcement beyond the host's native loading** — the §9.1 observable checkpoint is the S4 engine's gates, not a Noir-specific skill-enforcement layer.
- **User-authored skills** (drop into `.noir/skills/`) — the compiler discovers + emits them, but S5 focuses on the builtin pack.

---

## 2. Decisions (drafted; OQ-1…4 for review)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| DS-1 | Skill format | **Claude Code `SKILL.md`** (canonical) + Noir frontmatter | Richest format; natively shared by Qwen/Agy; lowest emulation cost (blueprint D8). YAML `name`/`description` + markdown body + optional `references/`. |
| DS-2 | `description` rule | **WHEN, never WHAT** | §9.1 / [Anthropic best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices): a WHAT-summary becomes a shortcut the agent follows instead of loading the body. "Use when starting any creative work" works; "dispatches subagents per task…" breaks. |
| DS-3 | Builtin pack | SDD lifecycle (9) + power skills (3), all `noir-` prefixed | User mandate: `noir-` prefix for management. 12 skills total. |
| DS-4 | Compiler | **Copy + validate** for Claude (v1) | Blueprint §6.5: Claude/Qwen/Agy COPY (same format); Gemini bundles; OpenCode down-converts. For v1 (Claude only), the "compiler" validates frontmatter + copies to `.claude/skills/`. A real transformer comes with S10. |
| DS-5 | Progressive disclosure | **One level**: SKILL.md (overview + trigger) → `references/*.md` (detail) | [Best practices](https://dotzlaw.com/insights/claude-skills/): one level is the practical limit before agents get lost in a doc tree. |
| DS-6 | Enforcement | **S4 engine's observable gates** (not skill-level rhetoric) | §9.1: replace Superpowers' ALL-CAPS rhetorical enforcement with the S4 engine's quiet, observable checkpoint. Skills are playbooks; gates are the discipline. |
| DS-7 | Source material | **Reuse `plugins/noir-workflow/`** skills as canonical source | Blueprint §1: existing markdown skills are reusable as canonical source material (low migration waste). The predecessor's `/init`, `/sync`, `/flow`, `/wrap`, `/checkpoint` map to the SDD lifecycle skills (renamed + `noir-` prefixed). |

---

## 3. The builtin pack — comprehensive catalog (28 skills, 6 categories)

Grounded in research: [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (24 skills), [awesome-claude-skills](https://github.com/karanb192/awesome-claude-skills) (50+), [Superpowers](https://github.com/obra/superpowers) (14-20), [Claude skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices), [FE skills](https://www.agensi.io/learn/best-frontend-skills-ai-agents-2026), [BE skills](https://awesomeskill.ai/skill/ai-agent-skills-backend-development). All `noir-` prefixed.

### A. SDD Lifecycle (7) — the core loop
| Skill | WHEN to trigger |
|---|---|
| `noir-intake` | starting a new feature/task from a raw idea, ticket, or issue |
| `noir-clarify` | an idea/spec has ambiguities — surface questions before committing (covers "discuss") |
| `noir-spec` | turning a brainstormed idea into a formal spec (what/why/acceptance/non-goals) |
| `noir-plan` | you have a spec and need a step-by-step implementation plan before touching code |
| `noir-execute` | executing a written implementation plan, task by task |
| `noir-verify` | about to claim work is complete — run verification before asserting success |
| `noir-document` | closing a work session — update docs, CHANGELOG, ADRs, memory |

### B. Power Skills (6) — discipline + quality
| Skill | WHEN to trigger |
|---|---|
| `noir-brainstorm` | before any creative work — creating features, components, adding functionality |
| `noir-debug` | encountering any bug, test failure, or unexpected behavior, before proposing fixes |
| `noir-review` | completing tasks or before merging to verify work meets requirements |
| `noir-tdd` | implementing any feature or bugfix, before writing implementation code |
| `noir-subagent` | executing implementation plans with independent tasks via fresh subagent per task |
| `noir-parallel` | facing 2+ independent tasks that can be worked on without shared state |

### C. Session / Context (4) — continuity
| Skill | WHEN to trigger |
|---|---|
| `noir-sync` | at the start of a session to load project context + recall memory |
| `noir-checkpoint` | mid-session to save state / resume in-flight work across interruptions |
| `noir-explore` | answering means sweeping many files/dirs/naming conventions — read-only fan-out search |
| `noir-wrap` | closing a session cleanly — tests, doc curation, commit-confirm, memory save |

### D. Git / Release (4) — version control
| Skill | WHEN to trigger |
|---|---|
| `noir-commit` | creating a git commit — conventional-commit scope, staged logically |
| `noir-pr` | committing + pushing + opening a PR in one flow |
| `noir-branch` | implementation complete, tests pass — decide how to integrate (merge/PR/cleanup) |
| `noir-worktree` | starting feature work that needs isolation from the current workspace |

### E. FE / BE / Domain (4) — specialized
| Skill | WHEN to trigger |
|---|---|
| `noir-frontend` | building or reshaping UI — distinctive visual design, typography, component patterns |
| `noir-backend` | building APIs, database schemas, server logic — patterns for robust scalable backends |
| `noir-security` | reviewing changes for security vulnerabilities — injection, auth, SSRF, data exposure |
| `noir-test` | writing tests — test design, coverage, edge cases, test quality (not just running them) |

### F. Utils / Meta (3) — tooling
| Skill | WHEN to trigger |
|---|---|
| `noir-doctor` | diagnosing environment/project health — deps, config, runtime, toolchain |
| `noir-skill-author` | creating new skills or editing existing ones (meta — TDD for process docs) |
| `noir-readme` | generating or updating README / docs from the codebase |

> **Scope note:** 28 skills is comprehensive. Not all need full content in S5 — see OQ-1 (how many to author with full playbooks vs stubs). The predecessor `plugins/noir-workflow/` provides proven content for ~5 (intake/sync/flow/wrap/checkpoint). Superpowers (installed locally) provides proven patterns for ~10 (brainstorm/spec/plan/execute/verify/debug/review/tdd/subagent/parallel). The rest (~13: explore/git/branch/worktree/frontend/backend/security/test/doctor/skill-author/readme) are net-new but well-documented in the research.

---

## 4. Architecture

```
@noir-ai/skills
├─ builtin/                 # canonical SKILL.md files (the 12 skills)
│  ├─ noir-brainstorm/SKILL.md + references/
│  ├─ noir-spec/SKILL.md + references/
│  └─ …
├─ compiler.ts              # validate + emit (canonical → host-native)
└─ index.ts

@noir-ai/adapters (claude emitter)
├─ emitSkills(ctx, opts) → copies compiled skills to .claude/skills/
```

The compiler is a **function**, not a heavy abstraction: `compileSkill(canonical, target: 'claude') → emitted files`. For Claude (v1), it validates frontmatter + copies. The adapter's `emitSkills` calls the compiler + writes to the host's skill dir (`.claude/skills/noir-<name>/`).

---

## 5. The "description = WHEN" rule (§9.1)

Each skill's `description` frontmatter describes **when to trigger**, not what the skill does. Examples:
- ✅ `"Use before any creative work — creating features, building components, adding functionality."` (noir-brainstorm)
- ❌ `"Guides the agent through a structured brainstorming process with clarifying questions."` (a WHAT — becomes a shortcut)

This is the single most exportable authoring rule from the Superpowers analysis (§9.1). Noir adopts it verbatim.

---

## 6. Enforcement: observable gates, not rhetoric (§9.1)

Noir deliberately does NOT copy Superpowers' ALL-CAPS rhetorical enforcement ("YOU MUST USE THIS SKILL", anti-rationalization tables). Instead:
- Skills sit in the host's namespace (at rest, only the `description` is visible).
- The host loads a skill on demand when its WHEN-trigger fires.
- **Discipline** comes from the S4 engine's gates (the observable checkpoint that records decisions). A skill is a playbook; the gate is the discipline.
- At decision points, the Noir daemon can nudge (via the `workflow_status` MCP tool) that a skill may apply — quietly, observably, escapably.

---

## 7. Testing & CI

- **Unit**: compiler validates frontmatter (rejects WHAT-descriptions, missing fields); emits to the right paths.
- **Integration**: `noir init` emits the builtin pack to `.claude/skills/`; re-run is idempotent (marker blocks or overwrite).
- **Content quality**: each skill's `description` passes the WHEN-not-WHAT check (automated regex/heuristic or manual review).

---

## 8. Open questions — RESOLVED (2026-07-24 review)

- **OQ-1 → 16 full + 12 stubs:** Full content (playbooks) for the 16 core skills (SDD lifecycle 7 + power skills 6 + sync/checkpoint/explore); the remaining 12 (git/FE/BE/utils) ship as stubs (name + description + minimal body — valid loadable skills, deepened later).
- **OQ-2 → Reuse + re-implement native:** Adopt proven content/patterns from predecessor `plugins/noir-workflow/` (~5) + Superpowers (~10) + net-new (~1 explore), **re-implemented as native Noir skills** in `@noir-ai/skills` — self-contained, `noir-` prefixed, **no runtime dependency** on predecessor or Superpowers. (Blueprint §9: "adopt the ideas, re-implemented as original native features.")
- **OQ-3 → Copy + validate compiler** for Claude (v1): validate frontmatter (name/description/references) then copy to `.claude/skills/`. A real transformer comes with multi-host (S10).
- **OQ-4 → `.claude/skills/`** (project-local): direct skill files the host loads. Simplest, works immediately.

---

## 9. References

- [Claude skill best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic — equipping agents with skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [agentskills.io specification](https://agentskills.io/specification)
- [SKILL.md development guide (GitHub)](https://github.com/anthropics/claude-code/blob/main/plugins/plugin-dev/skills/skill-development/SKILL.md)
- Parent: blueprint §6.4, §6.5, §9.1.

---

## 10. Next steps

1. **User reviews this draft** — confirm OQ-1…OQ-4.
2. On approval → **writing-plans** → subagent-driven implementation.
