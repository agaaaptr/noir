# Opt-in auto-capture via Claude Code hooks

> **Opt-in.** Noir never auto-installs this. `noir init` and `noir sync` do not
> touch your Claude Code `settings.json` hooks. You wire the block below
> deliberately, in the project (`.claude/settings.json`) or user
> (`~/.claude/settings.json`) scope you choose. If you never install it, Noir's
> memory is **explicit-save only** — the safe default.

This template shows how to turn Claude Code's hook events into Noir memory
observations automatically. It maps the four useful hooks
(`UserPromptSubmit`, `Stop`, `PostToolUse`, `PreToolUse`) onto the Noir CLI's
`memory capture` command, which reads the hook's stdin, builds a host-neutral
`CaptureEvent`, and writes an observation through the same `memory_save` path as
a deliberate save.

## What gets captured, and what does not

Capture, storage, and retrieval are **always local and free** (blueprint D6).
No hook on this page makes a network call or an LLM call. The only LLM surface in
Noir's memory layer is consolidation, which is separately provider-gated and off
by default — it is never triggered by these hooks.

The default policy (applied by `toSaveInput` in `@noir-ai/memory`) is
intentionally conservative, so memory stays signal-rich instead of flooding:

| Hook             | Default | Why                                                   |
|------------------|---------|-------------------------------------------------------|
| `Stop`           | capture | a session-end summary is the highest-value digest     |
| `UserPromptSubmit` | capture | the prompts you typed are your stated intent         |
| `PostToolUse`    | skip    | fires on every tool call; noisy + leaks tool inputs   |
| `PreToolUse`     | skip    | even noisier (pre-execution); almost never worth keep |

To capture tool events, pass `--hooks PostToolUse,PreToolUse` to `memory capture`
(or set `memory.capture.hooks` in `.noir/config.yml` once that config key ships).
The capture command applies the policy and skips events you did not ask for — a
skip is not an error.

## Privacy

Everything captured by these hooks is written to the **local** Noir store (an
embedded SQLite database under your project's `.noir/`). It is never sent to a
remote service. Tool inputs (commands, file paths) may contain secrets that are
already on your disk; if that is a concern, keep the default policy (skip tool
events) or point capture at a project-scoped store you control. You can erase
any observation with `memory_forget`, or the whole store with `noir`'s forget
flow.

## The hooks block

Add this to `.claude/settings.json` (project scope, recommended — keeps capture
local to this repo) or `~/.claude/settings.json` (user scope, every project).
Each hook forwards its full stdin JSON to Noir and lets Noir's policy decide
whether to persist:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "noir memory capture --stdin --event-type UserPromptSubmit"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "noir memory capture --stdin --event-type Stop"
          }
        ]
      }
    ]
  }
}
```

That is the recommended starting point — the two capture-by-default hooks, no
tool noise. To opt INTO tool-event capture as well, extend the block:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "noir memory capture --stdin --event-type UserPromptSubmit"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "noir memory capture --stdin --event-type PostToolUse"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "noir memory capture --stdin --event-type Stop"
          }
        ]
      }
    ]
  }
}
```

The `matcher` on `PostToolUse` restricts capture to file edits (a reasonable
middle ground between "nothing" and "every tool call"). Remove the `matcher` to
capture every successful tool call, or widen it (e.g. `"Bash|Edit|Write"`).

## What Claude Code sends, and what Noir reads

Each hook receives a JSON object on stdin. Claude Code's fields map onto Noir's
host-neutral `CaptureEvent` like this:

| Claude Code stdin field | Noir `CaptureEvent` field        |
|------------------------|----------------------------------|
| `hook_event_name`      | `event_type`                     |
| `session_id`           | `sessionId`                      |
| `cwd`                  | resolved to the canonical `project` id (never stored as a path) |
| (`timestamp` / `Date.now()`) | `ts`                        |
| `tool_name`            | `payload.toolName`               |
| `tool_input`           | `payload.toolInput`              |
| (`prompt` for UserPromptSubmit) | `payload.prompt`          |
| (a derived summary for Stop)    | `payload.summary`         |

The `memory capture` command performs that mapping, then calls `toSaveInput`,
which produces a `SaveInput` (`content`, `type`, `concepts`, `files`,
`sessionId`) and writes it via the same `MemoryEngine.save` path as the
`memory_save` MCP tool. An observation saved this way is recalled later with
`memory_recall` / `memory_search` exactly like one you saved by hand.

## Prerequisites

- The Noir CLI (`noir`) must be on `PATH` for the hook command. The
  `memory capture` / `memory save` subcommands ship with the Noir CLI slice
  (S9). Until then, this template is the documented opt-in shape — it is inert
  (a missing command exits non-zero, which Claude Code treats as a non-blocking
  error, so your session is unaffected).
- The Noir daemon should be running (`noir daemon start`) so the store handle
  is writable. If the daemon is down, the store opens read-only and `memory
  capture` refuses cleanly rather than failing mid-write.

## Verifying it is opt-in

`noir init` and `noir sync` do not write to `.claude/settings.json`. After
either command, grep your settings for `memory capture`: you will find nothing
unless you put it there. That is the contract — auto-capture exists only when
you have explicitly installed it.
