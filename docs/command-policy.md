# Command policy: interactive vs scriptable (TUI runtime)

> How `noir` decides what runs interactively vs headless, and the contract that keeps every subcommand 100% scriptable. The TUI-primary UX is the documented human entry point; **Approach B: never hard-gate a subcommand.**

## The policy (one sentence)

**Bare `noir` is the interactive home menu in a TTY and the `status` snapshot everywhere else; every subcommand works identically in both modes, and `--json` is the headless contract.**

There is no "interactive-only" *subcommand*. The only interactive *surface* is the bare-`noir` home picker. A non-interactive / headless run (CI, a pipe, `--no-input`, `--json`, `NO_COLOR`, or simply no TTY) is **never blocked** — it is simply routed around the picker to the same scriptable command the picker would have dispatched to. Interactive commands are *absent* from headless, not refused by it. This mirrors the framing of Claude Code's own command surface: the interactive entry exists for humans, and the same actions are reachable as plain commands for scripts.

## The three global flags (C1)

| Flag | Effect | Headless-safe? |
|---|---|---|
| `--tui` | Advisory hint that you want the home menu for bare `noir`. Still requires a TTY — in CI / a pipe it falls through to `status` exactly like the auto path. | Yes (no-op without a TTY) |
| `--no-tui` | Forces bare `noir` onto the **non-interactive `status` path even in a TTY**. The equivalent of piping `noir` into a non-TTY. | Yes (forces the headless path) |
| `--no-tips` | Suppresses redirect / deprecation hints on **stderr** (CI / log-friendly). stdout is unaffected. | Yes (purpose-built for CI) |

Defaults are **auto**: `--tui`/`--no-tui` absent ⇒ bare `noir` runs the home menu iff `isInteractive()` (TTY stdin && TTY stdout && !CI && !NO_COLOR && !`--no-input` && !`--json`). `--no-tips` absent ⇒ hints may appear on stderr.

These flags are **advisory routing for bare `noir` only**. They never disable, hide, or refuse any subcommand. `noir status --no-tui` is the same as `noir status`; the flag only changes what bare `noir` does.

## Command matrix

Every `noir` subcommand is in the **"works in both modes"** column. The bare home menu is the sole entry in the interactive-only column — and even it degrades gracefully to `status` headlessly.

| Command | Both modes? | Headless contract | Notes |
|---|---|---|---|
| `noir` (bare) | interactive surface (picker) | degrades to `noir status` (or `noir status --json`) | The only interactive *rendering*. `--no-tui` forces the non-interactive path even in a TTY. |
| `noir init` | yes | `--json` → `{ok, data: ScaffoldResult}` | Conflict resolution prompts only fire interactively; `--force` / `--json` / `--no-input` stay prompt-free. |
| `noir create [dir]` | yes | `--json` → `{ok, data: ScaffoldResult}` | Same prompt rules as `init`. |
| `noir sync` | yes | `--json` → `{ok, data: ScaffoldResult}` | `--force` / `--no-merge-regions` for non-interactive conflict handling. |
| `noir status` | yes | `--json` → `{ok, data}` | Probe-only — works daemon-down, never auto-starts. |
| `noir doctor` | yes | `--json` → `{ok, data}` | Exit 1 if any critical check fails (empty msg under `--json`). |
| `noir context search\|index\|status` | yes | `--json` → `{ok, data}` | |
| `noir memory recall\|save\|sessions\|forget\|consolidate` | yes | `--json` → `{ok, data}` | `memory save` prompts for `--content` interactively, or exit 2 under `--no-input`/`--json` when omitted. |
| `noir skills list\|sync` | yes | `--json` → `{ok, data}` | |
| `noir task new\|status\|advance\|next` | yes | `--json` → `{ok, data}` | |
| `noir daemon start\|stop\|status\|restart` | yes | `--json` → `{ok, data}` | `daemon status` exit 4 (DAEMON_DOWN) when not running. `start --detach` exits 2 (not implemented v1.x). |
| `noir mcp serve [--stdio]` | yes | n/a (server process) | Foreground server a host connects to. |

## The `--json` envelope (headless contract)

Every read-side command (and, since C1, `init` / `sync` / `create`) emits one of these on **stdout**, once, and writes nothing else to stdout:

```jsonc
// success
{ "ok": true, "data": { ... } }
// failure (fail() under --json)
{ "ok": false, "error": { "code": <number>, "message": "..." } }
```

The success envelope is the versioned S9 F11 shape. Under `--json` the stderr decorators (tables, spinners, banners, color) auto-disable, so stdout stays pristine JSON and a CI consumer can pipe `noir <cmd> --json` straight into `jq` or a parser.

## Exit codes (shared, both modes)

| Code | Meaning |
|---|---|
| 0 | ok |
| 1 | error |
| 2 | usage (missing flag, bad value, `--detach` not-implemented) |
| 3 | not-found (unknown command) |
| 4 | daemon-down (`daemon status` when no daemon) |
| 5 | cancelled (Ctrl+C at an interactive prompt) |

## What this means for scripts and CI

- Pin `noir status --json` for a health snapshot that never auto-starts a daemon and never prompts.
- Pin `noir init --json`, `noir sync --json`, `noir create --json` for structured conflict reports (`data.conflicts[]`) without a single prompt.
- Add `--no-tips` to keep stderr clean when a future deprecation ships (see [`deprecation.md`](deprecation.md)).
- Bare `noir` is safe in CI: it routes to `status` headlessly and exits 0.

## Future direction

A richer Ink-based `noir tui` dashboard is planned (roadmap C3). When it lands it will join the home menu in the "interactive surface" row — never in the scriptable columns. The contract above is the stable headless surface any future TUI is built on top of.
