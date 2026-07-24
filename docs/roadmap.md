# Noir — Roadmap & North Star

> **Living document.** This is the durable forward plan for the Noir AI toolkit. It exists so that **any future version of the project always knows where Noir is headed and why**. Update it as versions ship and the direction evolves.
>
- **Origin / detailed rationale:** `docs/specs/2026-07-23-noir-toolkit-design.md` (the full design blueprint + decision log).
- **Decisions of record:** `docs/decisions/` (ADR series, created at implementation).

---

## North Star

**Noir is the discipline, context, and memory layer that makes any AI CLI behave like a disciplined spec-driven engineer — and the foundation of the Noir AI ecosystem.**

- The **host CLI** is the execution engine (muscle).
- **Noir** is the workflow, context, and memory brain.
- **Bring your own agent.** Noir adapts to whichever agentic CLI the user already runs; it does not depend on any third-party plugin within its own flow.

The ecosystem goal: a portable, extensible toolkit that works across every major agentic CLI, with native memory/context, growing toward team and platform capabilities. v1 is deliberately small and sharp; the architecture is designed so the long-term vision is reachable **without rework**.

---

## Current status (living — update as slices ship)

> **As of 2026-07-24.** The single source of "where Noir is right now, what's built, and what's still missing." Update this whenever a slice ships or direction shifts — so no session loses the thread.

**Built & releasable (on `develop`, local — not pushed):**
- **Walking skeleton** (slices **S0 + S2 + S3-minimal**) — the integration thesis is *proven*: a host (Claude Code) connects to Noir over MCP and `host_status` round-trips over **stdio** (Gate 1) and a **daemon-backed Streamable HTTP** transport with stdio FS-fallback (Gate 2).
- **S1 Stores** — `@noir-ai/store`: embedded `better-sqlite3` + FTS5 (BM25, window snippets) + `sqlite-vec` (384-dim kNN), daemon-owned single writer, `ProjectId`-keyed DB at `.noir/store/<projectId>.db`, read-only FS-fallback, `store_status` MCP tool. Acceptance (persistence exists + queryable) MET; final review = release-ready.
- **S4 SDD Workflow Engine** — `@noir-ai/workflow`: hand-rolled FSM (Intake→Clarify→Spec→Plan→Execute→Verify→Document) with **observable, escapable gates** (§9.1 — every decision recorded; `--force` with reason; jump-to-phase), Full/Quick/Resume modes, cross-session resume, `.noir/` artifacts, `checkpoint` + `workflow_status` MCP tools. Acceptance (lifecycle runs end-to-end) MET; final review = release-ready.
- 6 packages `@noir-ai/{core,store,workflow,daemon,adapters,cli}`; MCP TS SDK **v2 beta (`2.0.0-beta.5`)**; toolchain pnpm/tsup/vitest/Biome/TS-ESM; CI (ubuntu+macos, node 22); MIT.
- 117/117 tests green; all acceptance gates verified; final whole-branch reviews = release-ready.
- Legacy plugin rebranded: marketplace `noir`, plugin `noir-workflow`.

**Next:**
- **S5 Builtin skills + compiler** — **spec done** (`docs/superpowers/specs/2026-07-24-s5-skills-design.md`); **28 skills** (16 full + 12 stubs, 6 categories), all `noir-` prefixed; copy+validate compiler; emit to `.claude/skills/`. OQ-1…4 resolved. **Ready for implementation** (writing-plans → subagent-driven).
- **Then:** S6 (context mgmt — indexing, RRF fusion, `context_search`) → S7 (memory mgmt — recall, consolidation, governance) → S8 (bounded model layer — spec/plan drafting) → S9 (CLI/TUI home screen) = **v1.0**.

**Still missing for v1.0 (the MVP target) — by design, built slice-by-slice:**
- the Noir skill pack + host compiler (S5); working-context indexing/retrieval (S6); long-term memory recall/consolidation/governance (S7); the optional bounded model layer (S8); the interactive TUI home screen (S9). Cross-CLI hosts (S10) and distribution/SDK (S11) are v1.x.

**Known v0 debt (documented in `.superpowers/sdd/progress.md`):** foreground daemon (detached/socket-activated is post-v0); single global `~/.noir/daemon.json` (concurrent-project clobbering); no daemon auth token; cosmetic nits.

**Goal (North Star, unchanged):** Noir = the discipline/context/memory layer that makes any agentic CLI behave like a disciplined spec-driven engineer. v1 MVP = a solo power-user doing idea→spec→plan→implement inside Claude Code with persistent cross-session memory.

---

## Version Targets

### v0.x — Foundation & Walking Skeleton  *(pre-release)*
**Slices S0–S2.** Monorepo, branding, `.noir/` store, SQLite/FTS5 stores, auto-managed daemon + Noir MCP server (stdio + HTTP).
- **Milestone:** a host CLI connects to Noir over MCP and a tool round-trips. The core integration thesis is proven end-to-end before any subsystem is deepened.

### v1.0 — Sharp Solo Experience  *(first public release)*
**Slices S3–S9.** Claude Code adapter + scaffolder, SDD workflow engine, builtin skills + compiler, context management, memory management, bounded model layer (optional), polished-but-minimal TUI home screen.
- **Target user:** a solo power-user doing idea → spec → plan → implementation inside **Claude Code**, with persistent cross-session memory.
- **Host scope:** **Claude Code only** (behind an abstract `HostAdapter` so generalization is later mechanical, not architectural).

### v1.x — Cross-CLI & Distribution
**Slices S10–S11.** Additional host adapters (OpenCode, Gemini, Agy, Qwen) with per-host emulation; Claude marketplace + npm publish; `noir doctor`; framework docs; SDK surface ("usable as a framework").
- **Milestone:** true cross-CLI + installable product.

### v2.0 — Ecosystem  *(long-term)*
- Cloud sync for memory (opt-in).
- Team / multi-user features: shared specs, plans, and memory across a team.
- First-class plugin/marketplace registry (Noir-native, not just Claude's).
- Full theming + plugin SDK.
- Programmatic headless driving of host CLIs (multi-step orchestration from the TUI).
- Possibly a hosted/managed offering.

---

## Deferred Features (explicit — not abandoned)

These are intentionally **out of v1** to keep scope sharp. Each has a target version so it is never silently lost:

| Feature | Target | Why deferred |
|---|---|---|
| Hosts beyond Claude Code | v1.x | Nail one host fully first; abstract adapter keeps it cheap. |
| Memory cloud sync | v2.0 | v1 is solo/local; sync adds auth + infra. |
| Team / multi-user | v2.0 | Requires shared stores, identity, permissions. |
| First-class Noir marketplace/registry | v2.0 | Claude marketplace suffices for v1 distribution. |
| Programmatic host-driving (`claude -p`, etc.) | v2.0 | v1 hands tasks off; full automation is later. |
| Full theming + plugin SDK | v1.x / v2.0 | Polish/en extensibility after core is solid. |

---

## Guiding Principles (durable)

1. **One CLI-agnostic core; hosts are thin targets.**
2. **`.noir/` is the single source of truth** — generated artifacts are pointers/transforms, never drifting copies.
3. **Daemon is the runtime authority**; TUI and hosts are clients.
4. **MCP = dynamic intelligence; static artifacts = declarative context/permissions/commands.**
5. **Graceful degradation everywhere** — no key → pure orchestration; daemon down → direct store; host lacks feature → emulate.
6. **YAGNI ruthlessly per version** — defer features deliberately (table above), never silently.

---

## How to use this roadmap

- **When shipping a version:** move the shipped items to a "Shipped" section (or release notes), advance the version target.
- **When direction changes:** update the North Star + Version Targets here, and record the *why* as an ADR in `docs/decisions/`.
- **When tempted to add scope:** check the Deferred table — if it is listed, it is intentional; add new deferrals here rather than dropping them silently.
