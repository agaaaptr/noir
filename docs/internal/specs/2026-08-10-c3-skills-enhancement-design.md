# C3 — Built-in Skill System Enhancement (design spec)

- **Date:** 2026-08-10
- **Status:** Draft (pending review)
- **Capability:** C3 — Built-in Skill System
- **Scope:** Deepen all 33 builtin skills + 1 integration to full quality playbooks; add per-skill registry (runtime-derived), structural quality gate, offline behavioral evals, and full docs sync. C3 → Completed.

---

## 0. TL;DR

Rework the shipped Noir skill pack from "22 full + 11 stubs, thin, no examples, no structure gate" into a **canonical-quality playbook pack**: every one of the 33 builtins (plus the ClickUp integration) becomes a substantive, WHEN+WHAT-described, progressively-disclosed playbook with concrete examples and a consistent template. Add a **runtime-derived skill registry** (no duplicated file — frontmatter is the single source of truth, queryable via CLI), a **structural quality gate** in the compiler (required sections, line budget, one-level reference depth, metadata presence), and an **offline evals harness** (`evals/evals.json` declared per agentskills.io + a vitest runner) so skill quality is continuously verified without any LLM/network dependency. Sync every doc so the roadmap reflects shipped reality (C3 → Completed).

## 1. Context

### 1.1 Current state (audited 2026-08-10)

- **33 builtin skills** in `packages/skills/builtin/` + **1 integration** (`noir-clickup`).
- **11 stubs (33%)** — all exactly 13 lines, share a `> **Stub:**` marker and a "When to use / For now" placeholder body: `noir-backend`, `noir-branch`, `noir-commit`, `noir-doctor`, `noir-frontend`, `noir-pr`, `noir-readme`, `noir-security`, `noir-skill-author`, `noir-test`, `noir-worktree`.
- **22 full** — but 15 are under 30 lines; only `noir-clickup` (155) / `noir-debug` (39) / `noir-tdd` (50) / `noir-parallel` (51) / `noir-subagent` (48) are substantive.
- **Zero `references/`** across all builtins (only `noir-clickup` has `references/clickup-api.md`). The backlog flags "`references/` skill code-path coverage (only synthetic fixtures today; 0 shipped skills use it)" as open.
- **Zero concrete examples / code fences** in any builtin (only clickup has 24).
- **All 34 descriptions are WHEN-led** (pass the compiler's leading-cue regex) but **WHEN-only** — no WHAT clause.
- **Frontmatter is only `{name, description}`** — no `license`, `compatibility`, `metadata`, `category`, `version`.
- **Template drift:** `noir-checkpoint`/`noir-sync` use `## Fallbacks`, `noir-wrap` uses `## Steps`, `noir-prd`/`noir-rules` use custom sections — 5 deviations from the de-facto `## Procedure` + `## Notes`.
- **Compiler (`compiler.ts`)** validates form only: frontmatter, WHEN-desc regex, `noir-<kebab>` name, dir==name, references `<kebab>.md` + non-empty. No body-structure, line-budget, or content checks.
- **Tests (`builtin-hygiene.test.ts`)** enforce the CURRENT 33 = 22+11 split and the stub markers — these must change when stubs are deepened.
- **Docs mis-info:** ADR-0002 says "31 builtins (19 full + 12 stubs)" — wrong; reality is 33 (22 full + 11 stubs).

### 1.2 Research grounding (17+ web refs + 5 machine refs)

Authoring canon (Anthropic platform docs, agentskills.io spec, Claude Code docs, OpenAI Codex, addyosmani, obra/superpowers, awesome-claude-skills, Cursor docs):

- **Frontmatter canon (6 fields):** `name`, `description`, `license`, `compatibility`, `metadata` (string→string map: author/version/category), `allowed-tools`. Claude Code adds `when_to_use`, `user-invocable`, `agent`, `context`, `shell`, `argument-hint`, `arguments`, `disable-model-invocation`. The 6-field core is the open agentskills.io standard; extra keys are Claude-Code-only and break claude.ai packaging.
- **Description = WHAT + WHEN** (Anthropic platform: "must say both what the Skill does and when to use it"). Superpowers advocates the stricter WHEN-only school (description must never summarize the workflow — the "trap"). We adopt **WHAT+WHEN** per user decision, keeping the WHEN trigger lead (existing rule) and adding a compact WHAT clause.
- **Body template** (consensus): Overview → When to Use → Process/Procedure (numbered) → Checklist → Common patterns/Examples → Red flags / What not to do → Verification/Evidence → Troubleshooting. Keep <500 lines; SKILL.md is a *navigator*, not a repository.
- **Progressive disclosure (3 levels):** L1 frontmatter (always in system prompt, name+description only) → L2 SKILL.md body (on trigger, <500 lines) → L3 `references/`+`scripts/`+`assets/` (on demand). **One-level-deep references only** — no chained references (SKILL.md → A.md → B.md). Descriptive filenames, forward slashes.
- **Quality mechanisms:** structural lint (required sections, budgets), behavioral evals (`evals/evals.json` with assertions; benchmark pass rate/time/tokens; offline assertions for mechanical checks; LLM-judge only for qualitative), registry/index files (category taxonomy), versioning at the pack/plugin level (not per-skill — only `metadata.version` convention).
- **Anti-patterns (consolidated):** vague descriptions ("Helps with documents"), description summarizes workflow, WHAT-not-WHEN, bloated >500-line SKILL.md, deeply nested references, over-broad rarely-triggering skills, first/second-person narration, ambiguous language, too many options, hard-coded paths, unqualified tool names, time-sensitive content, "voodoo constants", scripts that punt, duplicating model knowledge, non-descriptive filenames, no/abstract examples, untested skills, security naivety.

## 2. Decisions (locked with user)

| # | Decision | Chosen | Rationale |
|---|---|---|---|
| D1 | Scope | **Full**: deepen all 33 + registry + quality gate + evals | User mandate: "beresin capability 3 secara menyeluruh", no tech debt, all done in-session |
| D2 | Description style | **WHAT+WHEN** (Anthropic canon) | User decision; keeps the WHEN lead (existing validator) + adds WHAT clause |
| D3 | Registry | **Runtime-derived** (no committed file) | User decision; frontmatter is the single source of truth, CLI reads `discoverAll()` directly — no drift risk |
| D4 | Quality gate | **Structural** in `validateSkill` + new `lintSkill` (warn-level) + CLI `noir skills lint` | User decision; beyond metadata: sections, budget, depth, metadata presence |
| D5 | Evals | **`evals/evals.json` (agentskills.io) + vitest runner**, offline assertions only | User decision; standard format + runs in `pnpm test`; no LLM/network in CI |
| D6 | Registry surface | CLI: `noir skills list` gains Category + Status columns; `noir skills registry --json` emits the derived registry | "Queryable by the CLI" (C3 Done-when) |
| D7 | Reference deepening | Add `references/` to 5–8 heavy skills (debug, tdd, review, subagent, security, frontend, backend) | One-level-deep disclosure; closes the backlog "references/ code-path coverage" gap |
| D8 | Versioning | `metadata.version` per skill (e.g. `1.0.0`), pack version in `@noir-ai/skills` package.json | Canon convention (version lives at pack level; per-skill `metadata.version` is the per-skill convention) |
| D9 | No Superpowers rhetoric | All-CAPS Iron Laws / rationalization tables NOT copied (FORBIDDEN_RESIDUE bans `<EXTREMELY-IMPORTANT`, `SUBAGENT-STOP`) | ADR-0002 + `residue.ts`: adopt ideas, re-implement as original native Noir |

## 3. Target skill template (canonical)

```markdown
---
name: noir-<x>
description: <WHAT clause — what the skill does, 1 short sentence>. Use when <WHEN — trigger conditions>.
metadata:
  category: <category>
  version: 1.0.0
license: MIT
compatibility: claude · agents-md · gemini · cursor · opencode
---

# noir-<x>

<Overview: 1–2 sentences — what this skill does and when it applies.>

## When to use

- <trigger condition bullets — mirror the description; "especially when…", "don't skip when…">

## Procedure

1. **<Verb phrase>** — <step, with concrete specifics>.
2. … (numbered, bolded lead-ins; sub-steps as `###` only when a stage needs them)

## Verification

- [ ] <evidence checklist — what must be true before claiming done>

## Notes

- <edge cases, routing to sibling skills (`noir-spec` → `noir-plan`), degradation paths>
```

**Category taxonomy** (drives registry + docs table): `discovery`, `spec`, `plan`, `execute`, `verify`, `document`, `git`, `memory`, `context`, `domain`, `meta`, `integration`. (Reuses the CLI's existing `CATEGORY` map — now promoted to frontmatter metadata so it's data, not code.)

**Description rule (final):** MUST lead with a WHEN cue (existing regex), MUST contain a compact WHAT clause. Example: `noir-debug` → "Find and fix the root cause of bugs, test failures, or unexpected behavior. Use when encountering any bug, test failure, or unexpected behavior — before proposing a fix." ≤1024 chars (existing limit).

## 4. Architecture

```
@noir-ai/skills
├─ builtin/noir-<x>/SKILL.md (+ references/)   # all 33 full, metadata.category/version
├─ integrations/noir-clickup/SKILL.md           # already canonical (gold standard)
├─ evals/                                       # NEW
│  ├─ noir-tdd/evals.json
│  ├─ noir-debug/evals.json
│  └─ … (1–2 shipped examples, more optional)
├─ src/compiler.ts       # validateSkill extended (D4) + NEW lintSkill()
├─ src/registry.ts       # NEW — derive registry from discoverAll()
├─ src/quality.ts        # NEW — section/budget/depth checks (shared by validate+lint)
├─ src/index.ts          # export registry + quality + lintSkill
├─ test/builtin-hygiene.test.ts   # rewrite: no stubs, registry consistency, quality
├─ test/quality.test.ts           # NEW
├─ test/evals.test.ts             # NEW — vitest runner reads evals.json
└─ registry.json        # NOT created (runtime-derived, D3)

@noir-ai/cli
└─ src/commands/skills.ts   # list gains Category+Status; NEW `skills registry --json`; NEW `skills lint`
```

### 4.1 `registry.ts` (runtime-derived)

```ts
export interface SkillRegistryEntry {
  name: string;            // noir-<kebab>
  kind: 'builtin' | 'integration';
  category: string;        // from metadata.category (fallback: derivation from name)
  version: string;         // from metadata.version (default '0.0.0')
  status: 'full' | 'stub'; // derived: body has no '> **Stub:**' marker
  description: string;
  referenceCount: number;
  lines: number;
}

export function buildRegistry(): SkillRegistryEntry[]; // discoverAll() → map
```

CLI `noir skills registry --json` emits `{ok:true, data:{count, skills: SkillRegistryEntry[]}}`. `noir skills list` renders Category + Status columns.

### 4.2 Quality gate (`compiler.ts` + `quality.ts`)

**`validateSkill` additions (errors — fail emit):**
- `metadata` is present (object), has `category` (non-empty string) + `version` (semver-ish).
- Body has the required sections: `## When to use` (or `When to Use`), `## Procedure` (or `## Steps`), and one of `## Verification` / `## Notes` / `## Fallbacks`/`## Troubleshooting`.
- Body is ≤ 500 lines (canon <500).
- References are one-level deep (no reference file links to another reference file).
- Description contains a WHAT clause beyond the WHEN cue (a `—`/`.` separator with ≥1 substantive word after the trigger phrase).

**New `lintSkill` (warnings — non-failing, surfaced by `noir skills lint`):**
- Body ≥ 20 lines for a full playbook (the thin-body floor).
- At least one fenced code block OR concrete example for non-trivial skills.
- No first/second-person narration ("I", "we", "you" as the subject doing work).
- No "voodoo constants" (bare numbers as magic thresholds without justification).
- No time-sensitive version pins outside a "Legacy" section.
- References use descriptive kebab filenames.

**CLI `noir skills lint`**: runs `validateSkill` (errors) + `lintSkill` (warnings) over `discoverAll()`; exit 0 if no errors, exit 1 on errors; `--json` envelope. Warnings listed with skill name + rule.

### 4.3 Evals (`evals/` + vitest runner)

Declarative `evals/evals.json` per agentskills.io:

```json
{
  "skill_name": "noir-tdd",
  "evals": [
    {
      "id": "red-green-refactor-loop",
      "prompt": "Implement a feature. What is the first step?",
      "expected_output": "Write a failing test first.",
      "assertions": [
        { "type": "contains", "value": "failing test" },
        { "type": "not-contains", "value": "write the implementation first" }
      ]
    }
  ]
}
```

Runner `test/evals.test.ts` reads all `evals/**/evals.json`, validates the shape, and runs **offline assertions only** (`contains` / `not-contains` / `regex` / `length-gte`). No LLM, no network. The runner is the executable that turns the JSON declaration into a vitest suite; a `noir skills evals` command (or reuse of `noir skills lint`) can surface them. 2 shipped example evals: `noir-tdd`, `noir-debug` (more optional).

### 4.4 `docs-generate.mjs` enrichment

`genSkillsTable()` reads only `name`+`description` today. Enrich to also read `metadata.category` and render a `Category` column — additive, backwards-compatible. `reference/skills.md` becomes a richer index. (Optional but cheap and keeps docs as code.)

## 5. Content plan (per-skill target)

| Skill | Now | Target |
|---|---|---|
| noir-brainstorm | 18L full | 40–60L + references/ |
| noir-clarify | 18L | 35–50L |
| noir-spec | 23L | 45–60L + references/ (spec template) |
| noir-plan | 21L | 40–55L |
| noir-execute | 18L | 35–50L |
| noir-verify | 18L | 40–55L + Verification checklist |
| noir-document | 18L | 35–50L |
| noir-checkpoint | 19L (Fallbacks) | 35–45L, normalize to template |
| noir-sync | 19L (Fallbacks) | 35–45L, normalize |
| noir-explore | 17L | 35–50L + references/ |
| noir-recall | 19L | 35–45L |
| noir-remember | 24L | 40–50L |
| noir-context | 19L | 40–55L |
| noir-intake | 18L | 35–50L |
| noir-debug | 39L (gold) | 55–80L + references/ (tracing) |
| noir-review | 29L | 45–60L + references/ (review checklist) |
| noir-tdd | 50L (gold) | 60–85L + references/ |
| noir-subagent | 48L | 55–75L + references/ |
| noir-parallel | 51L | 55–75L |
| noir-prd | 36L (custom) | 45–60L, normalize |
| noir-rules | 35L (custom) | 40–55L, normalize |
| noir-wrap | 24L (Steps) | 40–55L, normalize |
| noir-commit | 13L stub | 35–50L full |
| noir-pr | 13L stub | 40–55L full |
| noir-branch | 13L stub | 35–45L full |
| noir-worktree | 13L stub | 35–50L full |
| noir-frontend | 13L stub | 40–60L full + references/ |
| noir-backend | 13L stub | 40–60L full + references/ |
| noir-security | 13L stub | 45–60L full + references/ |
| noir-test | 13L stub | 40–55L full + references/ |
| noir-doctor | 13L stub | 40–55L full |
| noir-skill-author | 13L stub | 50–70L full (meta-skill — the pack's style guide) |
| noir-readme | 13L stub | 35–50L full |
| noir-clickup | 155L (gold) | retain; add `metadata` |

All 33 + 1 get `metadata: {category, version}`, `license: MIT`, `compatibility`. All descriptions become WHAT+WHEN.

## 6. Docs sync (no drift)

- `docs/reference/skills.md` — auto-regenerate via `pnpm docs:generate` (now with Category column).
- `docs/roadmap/capability-03-builtin-skill-system.md` — status → Completed; update shipped section + close the "Done when" criteria.
- `docs/roadmap/STATUS.md` — C3 row → 🟩 Completed; sprint entry.
- `docs/roadmap/releases.md` — note C3 completion in the current-status block.
- `docs/roadmap/backlog.md` — move resolved C3 items (stubs, references/ coverage, registry, quality gate) into resolved history; keep evals-as-slice if partial.
- `docs/decisions/0002-native-skills-only-plugin-removed.md` — fix stale "31 builtins (19 full + 12 stubs)" → "33 builtins (22 full + 11 stubs → all full after C3 enhancement)".
- `CHANGELOG.md` — add unreleased C3 section.
- `AGENTS.md` — update the "Native skills" contract to mention metadata.category/version, WHAT+WHEN, quality gate, registry, evals.

## 7. Testing strategy

- **Unit:** `compiler.test.ts` extended — `validateSkill` new rules (metadata presence, required sections, ≤500 lines, one-level refs, WHAT clause). New `quality.test.ts` for `lintSkill`.
- **Hygiene:** `builtin-hygiene.test.ts` rewritten — no stub markers remain; every skill validates + passes structural gate; registry consistent with `discoverAll()`; docs table count matches.
- **Registry:** `registry.test.ts` — `buildRegistry()` returns 34 entries, categories resolve, status derives correctly.
- **Evals:** `evals.test.ts` — runner validates evals.json shape + runs offline assertions; 2 shipped examples pass.
- **CLI:** `cli/test/skills.test.ts` extended — `skills list` shows Category/Status; `skills registry --json`; `skills lint`.
- **Full gate:** lint → build → typecheck → test → docs:validate. Test suite stays offline/free (no LLM/network).

## 8. Acceptance criteria

- **Done when** — all 11 stubs compile without the `> **Stub:**` marker and pass the full pack validation (existing criterion).
- **Done when** — a skill registry with id/category/version/status/lifecycle exists (runtime-derived) and is queryable by the CLI (`noir skills registry --json`).
- **Done when** — the Skill Quality Gate CLI (`noir skills lint`) reports pass/fail per skill beyond metadata (body/reference/structure checks).
- **Done when** — `evals/evals.json` harness runs offline in `pnpm test` with ≥2 shipped example evals.
- **Done when** — all 34 descriptions are WHAT+WHEN; all skills carry `metadata.{category,version}` + `license` + `compatibility`.
- **Done when** — docs reflect reality: capability-03 → Completed, ADR-0002 count fixed, reference/skills.md has Category, no stale doc anywhere.
- **Done when** — full gate green; commits local on `develop`; tmp files cleaned.

## 9. Risks / mitigations

- **Scope is large** (34 skills × rewrite + 4 infra pieces). Mitigation: batch the content work via subagents (one agent per skill cluster), infra first (gate + registry + evals), then content.
- **Description rewrite could break `docs:validate`** (auto-gen table). Mitigation: run `pnpm docs:generate` after content; validate last.
- **Evals without LLM are weaker** than LLM-judge evals. Accepted per user decision — offline structural assertions are the CI-safe baseline; LLM-judge evals deferred to a future slice (documented in backlog).
- **`FORBIDDEN_RESIDUE`** — don't copy Superpowers rhetoric; the new template is original Noir. The quality lint's "no first/second person" must not reject legitimate Noir voice.
- **Existing tests enforce the 22+11 split** — must be rewritten in lockstep with content changes (both land in the same commit set).

## 10. Amendment — skill-trigger/adoption + curation (2026-08-10, post-review)

> Feedback from the user + dedicated research (10+ refs, cited in §10 refs): the host (Claude Code) does NOT proactively invoke Noir's skills — Superpowers triggers ~10%→66% via a SessionStart hook; Noir's skills are rarely triggered because selection is a probabilistic description-match against a 1%-of-context listing budget that silently drops the least-invoked descriptions first. This section records the design changes. Where it conflicts with §0–§9, this section wins.

### 10.1 The adoption problem (root-caused)

- **Selection mechanism:** Claude Code injects only each skill's `name` + `description` into the system prompt (L1). The model matches the request against that flat listing — probabilistic, not deterministic. No per-turn router.
- **Two budgets:** per-entry `description` + `when_to_use` truncated at 1,536 chars; whole-listing at ~1% of context → overflow drops least-invoked descriptions (a ratchet: Noir, being newer/less-prompted, drops first). 34 Noir + ~13 Superpowers + bundled ≈ overflow.
- **Precedence:** enterprise > personal (`~/.claude/skills/`) > project (`.claude/skills/`) > plugin > bundled. Plugin skills are namespaced (`superpowers:*`), so no name collision with `noir-*` — the real risk is listing-budget competition.
- **Why Superpowers fires:** a plugin **SessionStart hook** injects the full `using-superpowers` content as `additionalContext` → in context before first response. Measured: skill execution ~10%/6% → ~66%. Mechanism is a documented plugin feature (legit), but the "1% chance → MUST invoke" rule is a false-positive engine (criticized) and FORBIDDEN_RESIDUE bans its rhetoric.
- **The proven levers** (ranked): trigger-first mutually-exclusive descriptions in user vocabulary → keep visible set small → SessionStart-hook bootstrap of a *lean* router → budget/`skillOverrides` hygiene → selective CLAUDE.md/NOIR.md amplifier.

### 10.2 Design changes (locked with user)

| # | Change | Detail |
|---|---|---|
| A1 | **Router skill (`noir-sync` upgraded)** | Becomes the lean router (skill-radar style): fires on explicit signals (feature start, spec request, session start), STAYS SILENT on trivial edits; lists the high-value `noir-*` skills + when to use them in its body; ends with a follow-up offer (see A5). |
| A2 | **SessionStart hook bootstrap** | `noir init`/`sync` emit a project-scope `.claude/settings.local.json` SessionStart hook that injects a SHORT router contract (the rule + skill triage + follow-up norm, ~1 skill's worth of tokens — NOT the 117-line Superpowers version). Host-agnostic in spirit; claude emits the hook, other hosts (gemini/cursor/copilot) get the NOIR.md router instead. |
| A3 | **Description formula (v2)** | `[third-person what] + [when-to-use clause] + [real-user trigger phrases/nouns] + [boundary: "do NOT use for…"]`; trigger-complete first sentence (survives truncation); `when_to_use` frontmatter for 2–3 extra phrasings; mutually-exclusive across the pack; ≤1,536 combined chars. |
| A4 | **NOIR.md amplifier (host-agnostic)** | `NOIR.md` auto-brief (imported every session by claude/gemini/etc.) gains a short "Noir skills" block naming 3–5 high-value skills + when to use them. NOT CLAUDE.md (host-agnostic per user — future-proof for gemini/copilot). |
| A5 | **Follow-up/flow guidance in every skill** | Every skill (builtin + integration) MUST end with a "What next" section: the next gate's skill (from the SDD phase→skill map), an offer to continue the flow, AND room for improvisation ("or is there something else you'd like to do?"). The `noir-wrap`/`noir-handoff` phase→skill mapping (already in the engine) is the source — enhanced, not invented. |
| A6 | **Host-tool maximization** | Skills written to leverage the HOST's tools: e.g. Claude Code's `AskUserQuestion` for choices, `Task`/subagents for parallel work, MCP tools, `Read/Edit/Grep/Glob/Bash`. Written as host-agnostic INTENT + host-tool mapping table (claude/gemini/cursor/copilot), so each host maps intent→its own tool. Never hard-code a tool name as the only path. |
| A7 | **Skill curation (buang/merge/rename)** | Full audit of the 34-skill pack against research (high-value skills, naming conventions, overlap). Merge/rename/drop so EVERY skill is genuinely usable — no "dead" skills. Decision table to be produced from research (Task 14). Integration (clickup) improved with worked templates. |
| A8 | **ClickUp integration UX** | `noir-clickup` gains worked examples + placeholder templates: a task-detail fetch → PRD/spec draft flow, a status-update example, a batch-create template (H2-per-task MD + CSV), how to attach a task id; each with a follow-up step. |

### 10.3 Updated scope (adds to §1.1)

- Deepen + CURATE all skills (buang/merge/rename) — not just deepen.
- Router (`noir-sync` upgrade) + SessionStart hook emit (project `.claude/settings.local.json`) + NOIR.md amplifier block.
- Description formula v2 (trigger-first + boundary + `when_to_use`) across the pack.
- Follow-up "What next" section in EVERY skill.
- Host-tool maximization (intent + host mapping) in skills.
- ClickUp integration UX (worked templates).
- Registry + quality gate + evals unchanged (§2–§4).

### 10.4 New acceptance criteria (adds to §8)

- **Done when** — a SessionStart hook is emitted by `noir init`/`sync` that injects a lean router contract; verified it lands in `.claude/settings.local.json`.
- **Done when** — `noir-sync` routes to the relevant `noir-*` skill on explicit signals and stays silent on trivial edits; it ends with a follow-up offer.
- **Done when** — every skill's description is trigger-first + boundary + mutually-exclusive (a "would you hesitate?" test passes across the pack); `when_to_use` present where it adds signal.
- **Done when** — every skill ends with a "What next" (next gate's skill + improvisation offer).
- **Done when** — every skill references host tools as intent + mapping (not a single hard-coded tool as the only path).
- **Done when** — the 34-skill pack is curated: no redundant/overlapping skills remain; every skill is genuinely usable.
- **Done when** — `noir-clickup` ships worked examples + templates for fetch→PRD/spec, status update, batch create, and task-id attachment.

## 11. References (updated)

- [Claude Code — skills](https://code.claude.com/docs/en/skills) (L1/L2/L3 disclosure, 1,536-char cap, 1% listing budget, `when_to_use`, `skillOverrides`, `skillListingBudgetFraction`, precedence, `disable-model-invocation`)
- [Anthropic — Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices) (description = trigger, third person, trigger phrases)
- [Anthropic — steering Claude Code](https://claude.com/blog/steering-claude-code-skills-hooks-rules-subagents-and-more) (CLAUDE.md = facts, skills = procedures, SessionStart hooks)
- [dev.to — how Superpowers forces skill execution](https://dev.to/sonim1/how-superpowers-forces-skill-execution-3e6e) (SessionStart hook → additionalContext, 10%→66% lift)
- [dev.to — 5 actual causes skills don't trigger](https://dev.to/dev_encyclopedia/claude-code-skill-not-triggering-here-are-the-5-actual-causes-laj) (malformed YAML, wrong path, budget)
- [Steve Kinney — agent skills](https://stevekinney.com/writing/agent-skills) (probabilistic selection, mutually-exclusive descriptions, negative cases)
- [dev.to/rulestack — listing budget](https://dev.to/rulestack/too-many-claude-code-skills-how-the-listing-budget-decides-which-descriptions-claude-sees-4a6m) (ratchet effect, budget hygiene)
- [anthropics/claude-code #34648](https://github.com/anthropics/claude-code/issues/34648) (overload → bypass Skill tool, 0/10)
- [superpowers source — using-superpowers SKILL.md](https://raw.githubusercontent.com/obra/superpowers/main/skills/using-superpowers/SKILL.md) (1% rule, red flags)
- [skill-radar](https://github.com/Roni-quant/skill-radar) (lean router alternative; explicit triggers, no-skill list)
- [deepwiki — superpowers session lifecycle](https://deepwiki.com/obra/superpowers/4.4-session-lifecycle-and-bootstrap) (hook mechanics)

- [Anthropic — Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Anthropic — Equipping agents with skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)
- [agentskills.io spec](https://agentskills.io/specification) + [evaluating skills](https://agentskills.io/skill-creation/evaluating-skills)
- [Claude Code — skills](https://code.claude.com/docs/en/skills)
- [OpenAI Codex — skills](https://developers.openai.com/codex/skills/)
- [obra/superpowers](https://github.com/obra/superpowers) + writing-skills
- [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
- [karanb192/awesome-claude-skills](https://github.com/karanb192/awesome-claude-skills)
- [Cursor — rules](https://cursor.com/docs/rules)
- Machine references: `~/.agents/skills/`, `~/.claude/plugins/cache/**/superpowers`, `context-mode`, `rtk init`
