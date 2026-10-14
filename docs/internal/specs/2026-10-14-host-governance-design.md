# Host governance: project-context priming + agent-loop enforcement

Status: proposed · 2026-10-14

## Purpose

Give Noir real control over the host agent, not just advisory markdown a host
model can ignore. Two workstreams form one capability: prime the host with a
complete, budgeted project baseline when it syncs, and enforce Noir's discipline
through the host's lifecycle hooks. The host model becomes aware that Noir
governs the session, and hard constraints are enforced at the tool boundary.

The trigger was a pair of observations confirmed by a codebase audit: `detectStack`
already computes a rich `StackInfo` (languages, monorepo, frameworks, package
manager, CI, existing AI files) on every init and sync but discards it after
picking which ignore files to emit, so the host's auto-loaded context is only a
project id, a static skill list, and the rules seed. And `noir hook` is a
two-event static injector (`SessionStart`/`SubagentStart`, one fixed bundle) with
no per-event behavior and no deny path, wired for Claude only.

## Locked decisions

- **Two-tier architecture.** An advisory context file for awareness plus a
  lifecycle-hook layer for enforcement. Neither half is sufficient alone, and the
  MCP daemon is never presented as enforcement: native tool calls (`Bash`,
  `Write`, `Edit`) do not route through MCP, so only the host's own hook layer
  can gate them. The daemon stays the context, retrieval, and memory plane.
- **One dispatcher, thin adapters.** All policy lives in the `noir hook`
  dispatcher. Each host adapter emits only the small per-host wiring that invokes
  it, and the dispatcher prints the host's own decision dialect. No shared deny
  JSON: each host parses its own shape.
- **Claude is the full-enforcement anchor; the rest degrade honestly.** The
  ladder is deny-and-hold (claude) > deny-but-turn-continues (gemini, cursor) >
  throw-from-plugin (opencode) > advisory only (agents-md). A gate is never
  described as enforced on a host that cannot enforce it.
- **Hard constraints are a declarative deny-list at PreToolUse; discipline is a
  Stop gate.** Both deterministic and offline-testable. The Stop gate is opt-in
  because it changes when the session may end.
- **Awareness is a budgeted brief, injected at SessionStart.** It is compiled from
  `.noir/` and capped well under the 10,000-character `additionalContext` limit.
  Non-derivable doctrine (constraints, policy, pitfalls) stays in
  `AGENTS.md`/`CLAUDE.md`, the one channel every host reads with no truncation.
- **The derivable baseline is serialized into `.noir/NOIR.md`** as a managed block
  and regenerated on `noir sync`. Derivable facts do not occupy the always-loaded
  doctrine file.
- **Freshness is `noir sync --check`.** It fails when generated artifacts drift,
  mirroring the existing `docs:validate`/`hygiene:gate` discipline for host files.
- **`noir doctor` publishes a per-host coverage report:** which gates are enforced
  vs advisory, the resolved fail mode, and the version floor.

## Verified host capability

Facts below were verified against each host's primary hook documentation on
2026-10-14. The enforcement level Noir can claim is capped by this matrix.

| Host | Deny a tool call | Fail mode | Config file | SessionStart reaches model |
|------|------------------|-----------|-------------|----------------------------|
| claude | yes; `permissionDecision:"deny"` survives `bypassPermissions` | open by default; `onFailure:"block"` opt-in (v2.1.295+, command/http only) | `.claude/settings*.json` | yes (`additionalContext`, system-reminder) |
| gemini | yes; `{"decision":"deny"}` (alias `"block"`) or exit 2; turn continues | open (non-JSON stdout allows; exit 2 is the closed path) | `.gemini/settings.json` | yes |
| cursor | yes; `{"permission":"deny"}` or exit 2 | malformed response closes; crash/timeout opens unless `failClosed:true` | `.cursor/hooks.json` | yes (`additional_context`, fire-and-forget) |
| opencode | partial; throw from a plugin hook only | undocumented | `opencode.json` `plugin` array (no shell-hook block) | source-only, unverified |
| agents-md | no | none | `AGENTS.md` | yes (context) |

## Architecture

```
                 .noir/config.yml (enforcement.*)
                        │
                        ▼
   host hook ──►  noir hook --host <id>  ──►  dispatcher
   (stdin JSON)        │                        │
                       │   SessionStart/SubagentStart  → additionalContext (compiled brief)
                       │   PreToolUse                  → permissionDecision deny/allow
                       │   Stop                        → decision block (opt-in gate)
                       │   default                     → exit 0 (pass)
                       ▼
              host-dialect envelope (claude/gemini/cursor)
```

The dispatcher reads the event from stdin (existing), plus `tool_name`,
`tool_input`, `cwd`, and `session_id` for the events that carry them. `--host`
selects the output dialect. Config is loaded from the `.noir/` tree the hook
already walks up to find.

### Awareness (SessionStart / SubagentStart)

The injected brief is the existing `.noir/router.md` plus `.noir/rules/anti-slop.md`
plus a new compiled project baseline (stack, package manager, CI, canonical
commands, entry points). The compiler self-truncates to a budget below the
10,000-character cap and prefers pointers into `.noir/` over inlining. The full
doctrine stays in `AGENTS.md`/`CLAUDE.md`, which every host reads.

### Enforcement (PreToolUse deny)

A deny-list evaluator matches `tool_name` + `tool_input` against rules and emits
the host's deny shape when a rule matches. Rules come from `.noir/config.yml`
`enforcement.deny` plus a small built-in set. The built-in set protects Noir's
own invariants: deny writes to `.noir/.env` (0600 secrets) and `.noir/store/`
(the single-writer store). `enforcement.enabled` gates the whole layer.

Deny never ends the loop on gemini/cursor/opencode; the agent sees a tool error
and may retry. Only Claude's deny is a hard hold, and only Claude's Stop gate can
force the model to act before stopping.

### Enforcement (Stop gate, opt-in)

`enforcement.stopGate` makes `noir hook` on Stop check the active workflow task
and block with a reason when verification is pending, so the agent cannot finish
the turn before the spec/plan/verify gate passes. The check uses the existing
in-process read-only store path; if the store is unavailable it fails open and
does not block.

## Config

`NoirConfigSchema` in `@noir-ai/core` gains an `enforcement` block:

- `enforcement.enabled` (bool, default true) — emits the enforcement hooks and
  evaluates the deny-list.
- `enforcement.deny` (array of `{ tool?, pattern, reason }`) — extra rules.
  `tool` is optional and matches any tool when absent. `pattern` matches the
  `tool_input` string (a path substring for file tools, a command substring for
  Bash). `reason` is the deny reason the agent sees.
- `enforcement.stopGate` (bool, default false) — opt-in Stop gate.

## Non-goals

- No plugin or marketplace surface (ADR-0002). The dispatcher is a CLI command,
  not an installed plugin.
- No OpenCode plugin in this slice: its public-docs-vs-source API drift is
  unconfirmed, so `noir doctor` reports opencode as context-only until the plugin
  surface is verified against a running CLI.
- No prebuilt repo/symbol index. Retrieval stays agentic search by default with
  the existing BM25+kNN store as the opt-in path.
- No MCP `instructions` governance. It is injected by only three of five hosts,
  is truncated, and is opt-in on one; it is a short self-contained hint at most.
