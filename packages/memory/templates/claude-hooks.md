# Wiring Claude Code hooks to Noir memory (opt-in)

> **Opt-in.** Noir never auto-installs hooks. `noir init` and `noir sync` do not
> touch your Claude Code `settings.json`. You wire a hook deliberately, in the
> project (`.claude/settings.json`) or user (`~/.claude/settings.json`) scope
> you choose. Without hooks, Noir's memory is **explicit-save only** — the safe
> default.

## Current surface

Noir's memory layer is **explicit-save**: you (or the host, through the MCP
tools) decide what is worth keeping, and it is stored locally and free.

- CLI: `noir memory save|recall|search|forget|sessions|consolidate`
- MCP tools: `memory_save` / `memory_recall` / `memory_search` /
  `memory_forget` / `memory_sessions` (documented in the repo's
  `docs/reference/mcp-tools.md`)
- Storage is always local (`.noir/store/`), never sent to a remote service. The
  only LLM touch is **consolidation**, which is separately provider-gated and
  off by default.

## A dedicated `memory capture` command does not exist yet

An earlier draft of this template wired hooks to a `noir memory capture`
subcommand. That command is **not shipped** — a hook invoking it would exit
non-zero (a non-blocking error Claude Code ignores). Auto-capture is tracked as
a future slice; until it lands, use one of the explicit paths below.

## Wiring a hook today (explicit save)

A hook can call the explicit-save CLI with a static payload. This is useful for
a fixed, low-noise capture (e.g. every session `Stop` gets a "session ended"
observation), but it cannot introspect the hook's stdin JSON yet:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "noir memory save --content \"session ended — review what you learned\" --type observation"
          }
        ]
      }
    ]
  }
}
```

For richer capture, save from within the session via the `memory_save` MCP tool
(or `noir memory save`) — the deliberate path keeps memory signal-rich.

## Prerequisites

- The Noir CLI (`noir`) must be on `PATH` for the hook command.
- The Noir daemon should be running (`noir daemon start`) so the store handle
  is writable. If the daemon is down, the store opens read-only and saves
  refuse cleanly rather than failing mid-write.

## Verifying it is opt-in

`noir init` and `noir sync` never write to `.claude/settings.json`. After
either command, grep your settings for `noir memory` — you will find nothing
unless you put it there. That is the contract.
