# Capability 3 — Built-in Skill System

> **Status:** Partial — 33 builtins + 1 integration + compiler shipped; registry/versioning/quality-gate are research

## Overview

Noir ships skills as a native, first-party capability: a compiler that validates and emits `noir-` builtin skills into any supported host, a shipped pack of 33 builtins plus one integration, and a daemon seam for gated integrations. There is no plugin system and no marketplace (see ADR-0002) — this capability covers the skill compiler, the shipped pack, multi-host compilation, and the remaining skill-system infrastructure.

## Shipped today

- **33 builtin skills** in `packages/skills/builtin/` (22 full playbooks + 11 explicit stubs marked `> **Stub:**`), plus **1 integration** (`noir-clickup`).
- **Copy-and-validate compiler** at `packages/skills/src/compiler.ts`: `parseFrontmatter` → `validateSkill` → `compileSkill` → `emitSkillsToDir`, validating the whole pack fail-fast before writing.
- **WHEN-led description enforcement** in `validateSkill`: rejects WHAT-summaries, non-`noir-<kebab>` names, dir/name mismatches, descriptions over the max char limit, and empty/malformed references.
- **Multi-host compilation** in `compileSkill`: `claude` / `agents-md` / `gemini` / `opencode` get verbatim `SKILL.md` + `references/`; `cursor` compiles to a flat `.cursor/rules/<name>.mdc` rule.
- **Emission wired into the CLI** — `noir init` / `sync` / `create` / `skills sync`; emission is idempotent, prunes stale `noir-*` dirs, and is guarded by `assertNotUserOwned` (see `packages/skills/src/residue.ts`).
- **`noir skills list` (with `--json`) and `noir skills sync`** commands in `packages/cli/src/commands/skills.ts`.
- **Integration seam in the daemon** (`packages/daemon/src/integration-seam.ts` + `clickup-write.ts`): `integrations_auth` plus the `noir_clickup_write` gated-write-proxy, with an `integration.json` Zod schema (`packages/skills/src/integrations-schema.ts`) and runtime tiers (`none` / `gated-write-proxy` / `mcp-stdio` / `external-mcp`).
- **`docs/reference/skills.md`** auto-generated covering 34 skills from `packages/skills/builtin/*/SKILL.md` + `integrations/*/SKILL.md`.

## Gap / roadmap delta

- **Deepen the 11 stubs** (`> **Stub:**` playbooks) into full playbooks with real bodies and references.
- **Skill registry** — a central record of id/name/category/dependency/version/owner/compatibility/status/lifecycle. None exists today.
- **Per-skill versioning** plus a compatibility matrix across hosts and pack versions.
- **Official skill template + governance doc** so third-party contribution has a contract to follow.
- **Interactive-skill runtime** — a host-independent way for a skill to prompt for missing parameters at run time.
- **More integrations** reusing `integration.json` (GitHub, Linear, Jira, Notion, Slack).
- **Skill Quality Gate** beyond `validateSkill` metadata checks — a CLI/lint that checks body quality and structure.
- **Test + benchmark suite** — golden/snapshot/prompt-regression/compatibility tests, and a skill benchmark for token/latency/determinism.

## Acceptance criteria

- **MET** — `noir skills list --json` and `noir skills sync` run against the live pack and report 33 builtins + 1 integration.
- **MET** — `validateSkill` rejects a WHAT-style description, an over-limit description, and a `noir-` name/dir mismatch (verified in `packages/skills/src/compiler.ts`).
- **MET** — `compileSkill` emits verbatim `SKILL.md`+`references/` for claude/agents-md/gemini/opencode and a single flat `.mdc` for cursor.
- **MET** — `noir_clickup_write` is registered as a gated-write-proxy through the `integration.json` runtime-tier seam.
- **Done when** — all 11 stubs compile without the `> **Stub:**` marker and pass the full pack validation.
- **Done when** — a skill registry with id/version/owner/compatibility/lifecycle exists, and per-skill version + host compatibility are queryable by the CLI.
- **Done when** — the Skill Quality Gate CLI reports a pass/fail per skill beyond metadata (body/reference/structure checks) and a benchmark suite (token/latency/determinism) has baseline numbers.

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
