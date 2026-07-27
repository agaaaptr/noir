# Command policy: interactive vs scriptable (TUI runtime)

> How `noir` decides what runs interactively vs headless, and the contract that keeps every subcommand 100% scriptable. The TUI-primary UX is the documented human entry point; **Approach B: never hard-gate a subcommand.**

## The policy (one sentence)

**Bare `noir` is the interactive home menu in a TTY and the `status` snapshot everywhere else; every subcommand works identically in both modes, and `--json` is the headless contract.**

The only interactive surfaces are the bare-`noir` home picker and `noir tui`. Every other subcommand remains scriptable. A non-interactive / headless run (CI, a pipe, `--no-input`, `--json`, `NO_COLOR`, or simply no TTY) is **never blocked** from a scriptable command — bare `noir` is routed around the picker to the same command it would have dispatched. This mirrors the framing of Claude Code's own command surface: interactive entry points exist for humans, while the underlying actions remain plain commands for scripts.

## The three global flags

| Flag | Effect | Headless-safe? |
|---|---|---|
| `--tui` | Advisory hint that you want the home menu for bare `noir`. Still requires a TTY — in CI / a pipe it falls through to `status` exactly like the auto path. | Yes (no-op without a TTY) |
| `--no-tui` | Forces bare `noir` onto the **non-interactive `status` path even in a TTY**. The equivalent of piping `noir` into a non-TTY. | Yes (forces the headless path) |
| `--no-tips` | Suppresses redirect / deprecation hints on **stderr** (CI / log-friendly). stdout is unaffected. | Yes (purpose-built for CI) |

Defaults are **auto**: `--tui`/`--no-tui` absent ⇒ bare `noir` runs the home menu iff `isInteractive()` (TTY stdin && TTY stdout && !CI && !NO_COLOR && !`--no-input` && !`--json`). `--no-tips` absent ⇒ hints may appear on stderr.

These flags are **advisory routing for bare `noir` only**. They never disable, hide, or refuse any subcommand. `noir status --no-tui` is the same as `noir status`; the flag only changes what bare `noir` does.

## Command matrix

Every subcommand except `noir tui` is in the **"works in both modes"** column. The bare home menu degrades gracefully to `status` headlessly; `noir tui` requires a TTY and errors cleanly otherwise.

| Command | Both modes? | Headless contract | Notes |
|---|---|---|---|
| `noir` (bare) | interactive surface (picker) | degrades to `noir status` (or `noir status --json`) | Interactive *rendering*. `--no-tui` forces the non-interactive path even in a TTY. |
| `noir tui` | **interactive-only** (Ink dashboard) | n/a — exit 2 under `--json` / `--no-input` / non-TTY / CI / `NO_COLOR` | The Ink dashboard. Requires a TTY; under any non-interactive condition it fails exit 2 with a clear message (JSON envelope under `--json`, plain text otherwise). Lazy-loaded — React/Ink never enter the main CLI startup path (`noir status`, `noir doctor`, bare `noir` stay React-free). `/<command>` inputs dispatch through the same routing as the prompt. |
| `noir init` | yes | `--json` → `{ok, data: ScaffoldResult}` | Conflict resolution prompts only fire interactively; `--force` / `--json` / `--no-input` stay prompt-free. |
| `noir create [dir]` | yes | `--json` → `{ok, data: ScaffoldResult}` | Same prompt rules as `init`. |
| `noir sync` | yes | `--json` → `{ok, data: ScaffoldResult}` | `--force` / `--no-merge-regions` for non-interactive conflict handling. |
| `noir status` | yes | `--json` → `{ok, data}` | Probe-only — works daemon-down, never auto-starts. |
| `noir doctor` | yes | `--json` → `{ok, data}` | Exit 1 if any critical check fails (empty msg under `--json`). |
| `noir context search\|index\|status` | yes | `--json` → `{ok, data}` | |
| `noir memory recall\|save\|sessions\|forget\|consolidate` | yes | `--json` → `{ok, data}` | `memory save` prompts for `--content` interactively, or exit 2 under `--no-input`/`--json` when omitted. |
| `noir skills list\|sync` | yes | `--json` → `{ok, data}` | |
| `noir task new\|status\|advance\|next` | yes | `--json` → `{ok, data}` | |
| `noir handoff [--write]` | yes | `--json` → `{ok, data}` | Default output is a pasteable Markdown handoff on stdout; `--write` persists `.noir/handoff/<id>.md` (gitignored). |
| `noir wrap [--write]` | yes | `--json` → `{ok, data}` | Session-end alias for `noir handoff`. |
| `noir daemon start\|stop\|status\|restart` | yes | `--json` → `{ok, data}` | `daemon status` exit 4 (DAEMON_DOWN) when not running. `start --detach` exits 2 (not implemented v1.x). |
| `noir mcp serve [--stdio]` | yes | n/a (server process) | Foreground server a host connects to. |

## The `--json` envelope (headless contract)

Every read-side command (and `init` / `sync` / `create`) emits one of these on **stdout**, once, and writes nothing else to stdout:

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

The Ink-based `noir tui` dashboard has landed as the second interactive surface (joining the bare-`noir` home menu). It stays in the interactive-only column — never in the scriptable columns. The contract above is the stable headless surface the dashboard is built on top of: `noir status --json` is the same payload the dashboard's snapshot pane renders. Richer widgets (multi-pane layout, scrollback history, in-dashboard conflict resolution) are deferred to later revisions; the MVP ships host · mode · phase · daemon status, `/<command>` dispatch through the same routing as the prompt, and the standard quit/help/scroll keybindings.
