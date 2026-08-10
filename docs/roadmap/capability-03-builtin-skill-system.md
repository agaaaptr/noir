# Capability 3 — Built-in Skill System

> **Status:** Completed — 26 builtins + 1 integration, all full playbooks; runtime-derived registry; structural quality gate; offline evals harness. C3 → Completed (2026-08-10).

## Overview

Noir ships skills as a native, first-party capability: a compiler that validates and emits `noir-` builtin skills into any supported host, a shipped pack of 26 builtins (curated from 34 via merge+rename) plus one integration, and a daemon seam for gated integrations. There is no plugin system and no marketplace (see ADR-0002).

## Shipped today

- **26 builtin skills** in `packages/skills/builtin/` (curated from 34 via 5 merges + gerund renames), **all full playbooks** (zero stubs), plus **1 integration** (`noir-clickup` with auth gate, API pitfalls, verb dispatch).
- **Copy-and-validate compiler** at `packages/skills/src/compiler.ts`: `parseFrontmatter` → `validateSkill` (structural gate: metadata, required sections, line budget, one-level refs, WHAT+WHEN descriptions) → `lintSkill` (warnings) → `compileSkill` → `emitSkillsToDir`.
- **Quality gate** at `packages/skills/src/quality.ts`: `missingSections`, `withinLineBudget`, `chainedReferences`, `isWhatWhenDescription`, `lintWarnings`. `noir skills lint` CLI surfaces errors + warnings per skill.
- **Runtime-derived skill registry** at `packages/skills/src/registry.ts`: `buildRegistry()` from `discoverAll()`; `noir skills registry --json` queries it. No committed file — frontmatter is the single source of truth.
- **Offline evals harness** at `packages/skills/src/evals.ts` + `evals/**/evals.json` (agentskills.io format) + vitest runner in `test/evals.test.ts`. 2 shipped examples: `noir-test-driven-development`, `noir-systematic-debugging`.
- **Multi-host compilation**: `claude`/`agents-md`/`gemini`/`opencode` → verbatim `SKILL.md` + `references/`; `cursor` → flat `.mdc` rule.
- **Emission wired into CLI** — `noir init` / `sync` / `create` / `skills sync` / `skills list` / `skills lint` / `skills registry`. Idempotent, prunes stale `noir-*` entries, guards user-authored `noir-*` dirs via `assertNotUserOwned`.
- **Integration seam** (`integration.json` + daemon `integrations_auth` + `noir_clickup_write` gated-write-proxy).
- **`docs/reference/skills.md`** auto-generated covering 27 skills (26 builtin + 1 integration).
- **Spec:** `docs/internal/specs/2026-08-10-c3-skills-enhancement-design.md`; **Plan:** `docs/internal/plans/2026-08-10-c3-skills-enhancement.md`.

## Gap / roadmap delta (resolved)

- ✅ All 11 stubs deepened to full playbooks (zero stubs remain).
- ✅ Skill registry (runtime-derived, queryable via CLI).
- ✅ Per-skill metadata (category, version) in frontmatter.
- ✅ Official skill template + quality gate (structural: sections, budget, depth, WHAT+WHEN).
- ✅ Offline behavioral evals (evals.json + vitest runner).
- ✅ ClickUp integration enhanced (auth gate, API pitfalls, verb dispatch, attachment handling).
- Deferred: interactive-skill runtime, more integrations (GitHub/Linear/Jira), LLM-judge evals, benchmark suite.

## Acceptance criteria

- ✅ `noir skills list --json`, `noir skills sync`, `noir skills lint`, `noir skills registry --json` — all run against the live pack.
- ✅ `validateSkill` rejects missing metadata, missing sections, body >500 lines, chained refs, WHAT-only/WHEN-only descriptions; `lintSkill` reports warnings.
- ✅ `compileSkill` emits verbatim for claude/agents-md/gemini/opencode, `.mdc` for cursor.
- ✅ `noir_clickup_write` gated-write-proxy works via `integration.json` runtime-tier seam.
- ✅ All skills compile without `> **Stub:**` marker and pass full pack validation.
- ✅ Skill registry queryable via `noir skills registry --json`.
- ✅ Skill quality gate (`noir skills lint`) reports pass/fail + warnings per skill.
- ✅ `evals/evals.json` harness runs offline in `pnpm test` with 2 shipped example evals.
- ✅ Full gate green (1561 tests, lint, build, typecheck, docs:validate). C3 → Completed.

## References

- `packages/skills/src/compiler.ts`
- `packages/skills/src/integrations-schema.ts`
- `packages/skills/src/residue.ts`
- `packages/skills/builtin/`
- `packages/skills/integrations/noir-clickup/`
- `packages/cli/src/commands/skills.ts`
- `packages/daemon/src/integration-seam.ts`
- `packages/daemon/src/clickup-write.ts`
- `docs/decisions/0002-native-skills-only-plugin-removed.md`
- `docs/reference/skills.md`
