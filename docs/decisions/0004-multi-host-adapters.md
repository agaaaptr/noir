# ADR-0004: Multi-host adapters — the `resolveAdapter(host)` registry + AGENTS.md universal

- **Status:** Accepted
- **Date:** 2026-07-26

## Context

v1.0 (and v1.1.0-beta.1) shipped a single host: Claude Code, behind an abstract `HostAdapter` interface but with the CLI importing `claudeAdapter` directly in 8 places. The architecture was *built* to be host-agnostic (per [ADR-0003](0003-v1x-capabilities.md) and the v1.0 blueprint's "one CLI-agnostic core; hosts are thin targets" principle), but two concrete gates kept it Claude-only: (a) `host:` config was `z.literal('claude')`, and (b) the skills compiler's `CompileTarget` was Claude-only. Slice **S10** was the named gate to cross-CLI.

The forced question: in what shape do we generalize — one adapter per host with bespoke emission, or a shared foundation? And what do we do about the mid-2026 convergence on `AGENTS.md` as a cross-tool standard?

A key research finding collapsed the scope. **As of 2026-07, `AGENTS.md` is read natively by 32+ platforms** (Claude Code, OpenAI Codex, Cursor, Gemini CLI, JetBrains Junie, …) as the universal agent-context convention. That turns "5 bespoke adapters" into "one universal `AGENTS.md` emitter + specialized emitters only for hosts whose native format adds something `AGENTS.md` cannot express."

## Decision

**A single adapter registry over a typed `HostId` enum, with a shared universal `AGENTS.md` emitter every host composes.** Five decisions, all load-bearing:

### 1. The registry: `resolveAdapter(host)` over `HostId`

- `HostId = 'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode'` — the canonical union, owned by `@noir-ai/adapters` (one owner; `@noir-ai/core` and `@noir-ai/skills` redeclare only the string literals to avoid a cross-package dep).
- `resolveAdapter(host: HostId): HostAdapter` — a `Record<HostId, HostAdapter>` map with an exhaustiveness guard (a new `HostId` member that is not wired throws at runtime; TS narrows to `never` at compile time). The CLI's 8 direct `claudeAdapter` imports collapse to one `resolveAdapter(host)` call. Adding a host needs **no CLI edits** beyond the `--host` flag's enum.
- `SUPPORTED_HOSTS: readonly HostId[]` — a `Object.freeze`'d iteration list derived from the union, used by the CLI `--host` flag's `.choices(...)` and `noir doctor` host reporting.
- `host:` config widens from `z.literal('claude')` to `z.enum([...the same five...]).default('claude')`. `claude` is the **default and the regression anchor** — a bare `noir init` is byte-equivalent to pre-multi-host (the existing init/skills/doctor tests stay green, which is the acceptance gate).
- `CompileTarget` widens to the same enum so the skills compiler transforms per host.

### 2. AGENTS.md is the universal emitter — composed, not per-adapter

A **shared helper** `emitAgentsMd(ctx): string` produces the **byte-identical** `AGENTS.md` content for every host: a heading + a 3-line inline fallback summary + `@.noir/NOIR.md` + `@.noir/rules/RULES.md` `@`-imports. It is NOT a `HostAdapter`; every adapter composes it. The inline summary precedes the `@`-imports so AGENTS.md readers that do not resolve `@`-imports (plain markdown viewers, some dashboards) still get a one-glance pointer; the `@`-imports remain canonical for hosts that do resolve them (Cursor, Codex, Junie, …).

### 3. No-duplication gating — AGENTS.md only for hosts without a native context file

This is the subtle rule. AGENTS.md is **always emitted** (every host reads it), but the question is whether the host *also* has a native context file carrying the same content:

- **`claude`** keeps `CLAUDE.md` as the primary (managed `@import` + `RULES_BLOCK`); AGENTS.md is the universal baseline alongside it — **no content duplicated** into AGENTS.md (it carries only the canonical `@`-imports).
- **`gemini`** keeps `GEMINI.md` as the primary (Gemini's native `@import` form) + a root `AGENTS.md`; **no duplication** — same rule.
- **`agents-md` / `cursor` / `opencode`** have no native context file that adds anything beyond AGENTS.md, so **AGENTS.md is the context surface** (cursor additionally compiles skills to `.cursor/rules/*.mdc`; opencode adds `opencode.json`).

The gating principle: a host with a native context file (claude/gemini) uses it as primary and lets AGENTS.md be the universal pointer; a host without one (agents-md/cursor/opencode) uses AGENTS.md as the context surface itself. **One canonical source, never a drifting copy.**

### 4. The 4 adapters shipped + the 2 deferred

- **`agents-md`** — the smallest surface: root `AGENTS.md` (context + rules unified) + a `.mcp.json` (Claude-shape, broadly compatible; many AGENTS.md readers also read it). No skills dir, no `emitRules` (rules live in the AGENTS.md content).
- **`gemini`** — `GEMINI.md` (context + folded rules, Gemini's native `@import` form) + root `AGENTS.md` + `.gemini/mcp.json`. No skills dir.
- **`cursor`** — `AGENTS.md` (context) + `.cursor/rules/*.mdc` (skills compile to **flat** `.mdc` with YAML frontmatter `description`/`alwaysApply:false`) + `.cursor/mcp.json`. The `@.noir/rules/RULES.md` import inside AGENTS.md IS the rules surface for cursor — no separate host-rules pointer. Cursor reads both `AGENTS.md` and `.cursor/rules/`.
- **`opencode`** — `AGENTS.md` + `opencode.json`. The MCP config shape is **distinct**: OpenCode's `mcp` block entries are `type`-tagged (`{type:'local', command:[...]}` for stdio, `{type:'remote', url}` for HTTP), **not** the `{mcpServers:{...}}` family. Verified against `https://opencode.ai/docs/mcp-servers/` + `https://opencode.ai/config.json` (the `$schema` is stamped on the emitted file). No skills dir.

**Deferred:** `qwen` and `agy` — lower priority; the universal `AGENTS.md` emitter covers them in the meantime (they behave identically to `agents-md` until their native adapters land).

### 5. `--host` is single-select; multi-host emit is future

`noir init`/`create`/`sync` gain a `--host <id>` flag (default `claude`); `host:` in `.noir/config.yml` persists the choice. v1.x is **single-host select**: `host:` picks ONE primary host (+ always-`AGENTS.md`). Emitting for several hosts at once (`hosts:[...]`) is a deliberate non-goal for v1.x — recorded here so it is not silently assumed.

### `noir doctor` + the SDK remainder (S11)

- `noir doctor` reports the **active host** and verifies the host-specific artifacts exist (a `host:{active, expected, missing}` check).
- S11's named remainder — `docs/sdk.md` (the per-package framework/library API, including the `@noir-ai/adapters` `HostAdapter`/`resolveAdapter`/`SUPPORTED_HOSTS` surface) and a `noir doctor` `publish` check (advisory package-metadata validation) — ships alongside S10 in `v1.2.0-beta.1`.

## Consequences

- **Cross-CLI is mechanical, not a rewrite.** The host-specific surface is concentrated in one registry. A new host is: extend `HostId`, author an adapter, register it in `resolveAdapter`, and the schema + compiler + `--host` flag + `noir doctor` widen automatically — no CLI surgery.
- **AGENTS.md is the universal contract — and it stays byte-identical across hosts.** Because a shared helper produces it (not each adapter), there is one content to test, one to update, and it cannot drift per host. Hosts compose it; they do not re-author it.
- **No duplication = no drift.** Claude/Gemini projects carry `CLAUDE.md`/`GEMINI.md` (primary) + `AGENTS.md` (universal pointer); the canonical source is always `.noir/`. The pre-multi-host Claude output is unchanged.
- **Cursor skills lose Claude-specific skill semantics** (references/, progressive disclosure) — the `.mdc` body is the skill body, references inlined or skipped. Documented; acceptable for v1.x.
- **OpenCode's distinct MCP shape is a known wrinkle** — it cannot reuse the `{mcpServers}` helper; its adapter emits its own `$schema`-stamped `opencode.json`. Future hosts with non-`{mcpServers}` shapes follow the same per-adapter pattern.
- **`qwen`/`agy` are deferred, not blocked.** They work today via the universal `AGENTS.md`; their native adapters are an authoring task, gated only by priority.
- **Multi-host emit is future.** A project that wants to target two CLIs simultaneously today runs `noir init --host <a>` then `noir sync --host <b>` (advanced override); a real `hosts:[...]` emitter is a later beta.

## References

- Design record: [`superpowers/specs/2026-07-25-s10-multihost-design.md`](../superpowers/specs/2026-07-25-s10-multihost-design.md)
- Release narrative: [`CHANGELOG.md`](../CHANGELOG.md) §`1.2.0-beta.1`
- Related: [ADR-0003](0003-v1x-capabilities.md) (the keystone `HostAdapter.emitRules` seam S10 generalizes; K/R/I/P/S/X), [ADR-0002](0002-native-skills-only-plugin-removed.md) (native skills only), [ADR-0001](0001-doc-layout-and-spec-plan-paths.md) (doc layout)
