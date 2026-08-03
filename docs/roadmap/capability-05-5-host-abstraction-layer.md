# Capability 5.5 — Host Abstraction Layer (HAL)

> **Status:** Shipped core — 5 adapters + universal AGENTS.md; capability negotiation/certification are research

## Overview

Noir is host-agnostic behind an abstract `HostAdapter`. `@noir-ai/adapters` ships 5 adapters, a `resolveAdapter` registry, per-host emission (CLAUDE.md / GEMINI.md / `.mdc` / opencode.json / AGENTS.md), and a handoff seam. Capability negotiation, prompt compilation, and host certification remain open.

## Shipped today

- **5 host adapters** — `claude`, `agents-md`, `gemini`, `cursor`, `opencode` ([`packages/adapters/src`](../../packages/adapters/src/)); `resolveAdapter(host)` registry with an exhaustiveness guard ([`index.ts`](../../packages/adapters/src/index.ts)).
- **`SUPPORTED_HOSTS`** frozen list consumed by CLI `--host` choices and `noir doctor` ([`index.ts`](../../packages/adapters/src/index.ts), [`bin.ts`](../../packages/cli/src/bin.ts)).
- **`host:` config** widened to a 5-value `z.enum`, default `claude` (regression anchor for single-host projects) ([`config.ts`](../../packages/core/src/config.ts)).
- **`CompileTarget`** widened; cursor skills compile to flat `.mdc`; shared universal AGENTS.md emitter `emitAgentsMd` ([`agents-md.ts`](../../packages/adapters/src/agents-md.ts)).
- **Per-host MCP shapes** — `claude`/`agents-md` → `.mcp.json`, `gemini` → `.gemini/mcp.json`, `cursor` → `.cursor/mcp.json`, distinct type-tagged `opencode.json` ([`mcp.ts`](../../packages/adapters/src/mcp.ts)).
- **`--host` flag** on `noir init` / `create` / `sync`; per-host emission matrix in `buildHostArtifacts` ([`doctor.ts`](../../packages/cli/src/commands/doctor.ts), [`manifest.ts`](../../packages/create/src/manifest.ts)).
- **Skills emission per host** — `claude` → `.claude/skills/`, `cursor` → `.cursor/rules/`, others skipped with a note.
- **`noir doctor` host check** — `host:{active,expected,missing}`; **`noir handoff`** — `hostLaunchDirective` + `defaultHandoffBlock` ([`handoff.ts`](../../packages/cli/src/commands/handoff.ts), [`handoff.ts`](../../packages/adapters/src/handoff.ts)).
- Shipped since `1.2.0-beta.1`; ADR-0004 Accepted ([`0004-multi-host-adapters.md`](../decisions/0004-multi-host-adapters.md)).

## Gap / roadmap delta

- **Capability negotiation / host feature discovery** — zero code; typed probe seam on `HostAdapter` (e.g. `hasSkills` / `hasMcpShape`) is the design reference ([`types.ts`](../../packages/adapters/src/types.ts)).
- **Host config beyond `host:` enum** — endpoint / model / provider / auth / feature flags.
- **`qwen` + `agy` adapters** — deferred; universal AGENTS.md covers them.
- **Multi-host emit (`hosts:[...]`)** — explicit v1.x non-goal in ADR-0004.
- **Per-host `emitHandoff` implementations** — optional seam; none implement it ([`types.ts`](../../packages/adapters/src/types.ts)).
- **`install?` / `healthCheck?` seams** — declared optional; none implement ([`types.ts`](../../packages/adapters/src/types.ts)).
- **Compatibility matrix + host certification process.**
- **Error recovery strategies** — largely doc-scope; Noir does not call LLM providers directly.
- **Prompt compilation pipeline** (Skill → Shared Instruction → Project Context → Host Context → Formatter) — the sharpest gap vs. the doc vision.
- **Response normalization** — contradicts the bring-your-own-agent architecture; resolve as a non-goal.

## Acceptance criteria

- **MET — 5 adapters** (`claude`, `agents-md`, `gemini`, `cursor`, `opencode`) resolve via `resolveAdapter(host)` with an exhaustiveness guard; `SUPPORTED_HOSTS` is frozen and drives CLI `--host` choices and `noir doctor`.
- **MET — per-host emission** — `noir init` / `create` / `sync --host` emit the host's native context file, MCP config, and skills (`.claude/skills/`, `.cursor/rules/`); `claude` remains the default and single-host projects stay byte-equivalent.
- **MET — handoff seam** — `noir handoff` produces a host-correct launch directive + default handoff block for every supported host (covered by `packages/adapters/test/handoff.test.ts`).
- **DONE — capability negotiation** — `HostAdapter` exposes a typed probe (e.g. `hasSkills` / `hasMcpShape`) and the CLI consumes it instead of hardcoded per-host knowledge.
- **DONE — certification** — a published compatibility matrix plus a defined host-certification process; certified hosts are listed in docs.
- **DONE — prompt compilation** — a real Skill → Host Context → Formatter pipeline lands on at least one host, or the gap is explicitly re-scoped as a non-goal in ADR-0004.

## References

- [`packages/adapters/src/index.ts`](../../packages/adapters/src/index.ts)
- [`packages/adapters/src/types.ts`](../../packages/adapters/src/types.ts)
- [`packages/adapters/src/claude.ts`](../../packages/adapters/src/claude.ts)
- [`packages/adapters/src/gemini.ts`](../../packages/adapters/src/gemini.ts)
- [`packages/adapters/src/cursor.ts`](../../packages/adapters/src/cursor.ts)
- [`packages/adapters/src/opencode.ts`](../../packages/adapters/src/opencode.ts)
- [`packages/adapters/src/handoff.ts`](../../packages/adapters/src/handoff.ts)
- [`docs/decisions/0004-multi-host-adapters.md`](../decisions/0004-multi-host-adapters.md)
- [`docs/internal/specs/2026-07-25-s10-multihost-design.md`](../internal/specs/2026-07-25-s10-multihost-design.md)
