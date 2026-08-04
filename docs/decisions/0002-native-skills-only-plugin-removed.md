# ADR-0002: Native skills only — plugin + marketplace removed

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

This repository grew from a Claude Code plugin marketplace: the `ai-toolkit` marketplace shipping the `ai-dev-workflow` plugin, later rebranded to the `noir-workflow` plugin. That plugin was a pure-markdown skill pack (`/init`, `/sync`, `/flow`, `/wrap`, `/checkpoint`) with no Node/TS runtime — it delegated to third-party plugins (Superpowers, context-mode, agentmemory) and used a predecessor state file (`workflow/<task>`), a `noir-workflow.mode` flag, and ClickUp-based task intake.

v1.0 reimagined Noir as a **host-agnostic toolkit**: a pnpm monorepo of 10 `@noir-ai/*` packages with a daemon, a single MCP server, an SDD workflow engine, native context + memory, and its own native skill pack compiled by `@noir-ai/skills`. Under that model the plugin marketplace, the predecessor plugin directory (`plugins/noir-workflow/`), the marketplace manifest (`.claude-plugin/`), and the pre-Noir skill/spec/plan/findings artifacts are redundant — the toolkit's native builtin skills fully supersede them, and the toolkit reaches the host via MCP + `noir init`/`sync` rather than via a plugin install.

## Decision

**Noir ships ONLY native `noir-` builtin skills**, delivered through `@noir-ai/skills` and emitted by `noir init` / `noir sync` to the host's skills directory (`.claude/skills/` for Claude Code). There is no plugin to install and no marketplace to add.

Specifically removed:
- `plugins/noir-workflow/` — the predecessor Claude Code skill-pack plugin.
- `.claude-plugin/` — the marketplace manifest.
- Pre-Noir spec/plan/findings artifacts that described the plugin identity.

The native skill pack is the single skill mechanism: 31 builtins (19 full playbooks + 12 stubs) in canonical `SKILL.md` format, validated by the `@noir-ai/skills` compiler (WHEN-led `description`, `noir-` prefix, dir-equals-name) and guarded against predecessor residue (`FORBIDDEN_RESIDUE` in `packages/skills/src/residue.ts`).

## Consequences

- **One skill mechanism.** A single, host-agnostic, compiler-validated native skill surface — no plugin/marketplace duality to document, maintain, or drift.
- **No plugin install step.** Users get every skill from `noir init` / `noir sync`; the `noir-*` namespace is managed and overwritten on every sync.
- **Host-agnostic by construction.** S10 (more host adapters) extends the builtin compiler's `CompileTarget` and the adapter registry — it does not revive a plugin model.
- **Privacy/provider-explicit rules unchanged** — the native skills orchestrate the host; any model touch stays opt-in and provider-explicit.
- **In-tree history trade-off.** Readers lose the plugin-era history in the tree (the `plugins/` directory, marketplace manifest, and pre-Noir specs). The durable rationale is retained here, in the design blueprint (`docs/internal/specs/2026-07-23-noir-toolkit-design.md`, itself a dated design record), and in ADR-0001. The native skill pack carries forward the predecessor's best playbook content as original Noir re-implementations.
