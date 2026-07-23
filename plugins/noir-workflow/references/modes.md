# Modes & Graceful Degradation

Every `noir-workflow` skill Reads this on first use to detect its operating mode and degrade gracefully. Applies to both **rich** (plugins installed) and **lean** (no plugins) operation.

## Operating modes
- **Rich** — plugins installed (Superpowers, context-mode, agentmemory): maximal capability, more tokens.
- **Lean** — no plugins: token-efficient fallbacks, still systematic.
- Default: **auto** (detect). Override via `noir-workflow.mode` (below).

## Mode detection (auto + override)
1. **Override first.** Read `noir-workflow.mode` from `CLAUDE.md`/`AGENTS.md`. Values: `auto` (default) | `rich` | `lean`. If `rich`/`lean`, force it and skip detection.
2. **Auto-detect** (only when `auto`): inspect the tool/skill list — cheaply, without invoking heavy tools — for each plugin:
   - **context-mode** → is `mcp__plugin_context-mode_context-mode__ctx_search` available?
   - **agentmemory** → is `mcp__agentmemory__memory_recall` available?
   - **superpowers** → is the skill `superpowers:brainstorming` available?
3. Record which of the three are present.

**Per-capability, not all-or-nothing.** A skill uses the rich path for each capability present and the lean fallback for the rest (e.g. context-mode present but agentmemory absent → rich retrieval, lean memory).

## Capability matrix (rich → lean)

| Capability | Detect | Rich | Lean fallback |
|---|---|---|---|
| Retrieval (docs/knowledge) | context-mode tools | `ctx_index` / `ctx_search` | `Read` on-demand + `Grep` |
| Memory (cross-session) | agentmemory tools | `memory_recall` / `memory_save` | native `MEMORY.md` + `workflow/<task>.md` |
| Process (brainstorm/spec/plan/execute) | superpowers skills | delegate (`brainstorming` / `writing-plans` / `executing-plans` / …) | inline lean version (per-skill `references/`) |

## Graceful-degradation rules
- **Never fail silently.** If a rich tool is unavailable, use the documented fallback AND tell the user (e.g. "agentmemory not installed — using `MEMORY.md`").
- **Probe cheaply** — introspect the tool/skill list; don't call heavy tools just to detect.
- **On uncertainty** about availability → ASK the user (no assumption).

## Spine (both modes)
**Investigate → Confirm → Act.** Confirm at each gate. No execution before facts are gathered AND the user confirms understanding. Holds in rich and lean alike.
