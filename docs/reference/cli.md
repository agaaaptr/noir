# CLI Command Reference

> Auto-generated from `noir --help` output.

```
Usage: noir [options] [command]

Noir — discipline, context, and memory layer for agentic CLIs.

Options:
  -v, --version                     output the version number
  --json                            emit machine-readable JSON to stdout
  --no-input                        never prompt; error if input is required
  --quiet                           suppress non-essential diagnostics
  --verbose                         show additional diagnostic detail
  --cwd <path>                      run as if started in <path>
  --tui                             prefer the interactive home menu for bare
                                    `noir` (advisory; TTY-only)
  --no-tui                          route bare `noir` to the non-interactive
                                    `status` path even in a TTY
  --no-tips                         suppress redirect / deprecation hints on
                                    stderr
  -h, --help                        display help for command

Commands:
  init [options]                    scaffold Noir in the current project
                                    (.noir/, .mcp.json, CLAUDE.md, skills)
  create [options] [dir]            bootstrap the Noir AI layer in a new or
                                    empty directory
  sync [options]                    re-emit Noir managed files (.mcp.json,
                                    CLAUDE.md blocks, NOIR.md brief, ignores) +
                                    skills
  mcp                               MCP server control
  daemon                            control the Noir daemon
  doctor [options]                  environment + project health
  status                            project + daemon + workflow + store
                                    snapshot
  context                           context engine (S6)
  memory                            memory engine
  skills                            builtin skills (S5)
  task                              workflow task control
  install|migrate [options] [spec]  install Noir via the native managed-Node
                                    path (or migrate from another install
                                    method)
  update [options] [spec]           update Noir to the latest version via the
                                    active install method
  handoff [options]                 emit a ready-to-paste host handoff prompt
  wrap [options]                    session-end alias for `noir handoff`
  tui                               interactive Ink dashboard (host · phase ·
                                    daemon + /command dispatch)
```

## Global Flags

| Flag | Description |
|---|---|
| `--json` | Machine-readable output (data → stdout, diagnostics → stderr) |
| `--no-input` | Never prompt; CI/pipe-safe |
| `--quiet` | Suppress non-error output |
| `--verbose` | Detailed diagnostics |
| `--cwd <dir>` | Working directory |
| `--tui` / `--no-tui` | Advisory routing for bare `noir` |

## `noir tui` — interactive dashboard

The TUI dashboard (Ink) is a command palette + status + output view. Keybindings:

| Key | Action |
|---|---|
| `Ctrl+K` | Open the **command palette** (fuzzy-searchable, grouped, recent-first on empty query) |
| `Ctrl+F` | **Search** the captured output of the last dispatched `/command` (`n`/`N` next/prev, `Esc` exit) |
| `/command` | Type + `Enter` to dispatch any `noir` subcommand through the same router as the CLI |
| `↑` / `↓` | Scroll the output pane; recall input history on an empty `/`-input |
| `Enter` | Run the typed `/command` / select in the palette |
| `Esc` | Back: clear input → dismiss output → quit |
| `q` | Quit (when the input is empty) |
| `?` | Toggle help |
| `Ctrl+C` | Force exit |

Destructive commands selected from the palette (e.g. `context index --force`) show a `y/N` confirmation overlay first. Recent commands persist per-project at `~/.noir/<projectId>/tui-history.json` (opt-out: `NOIR_DISABLE_TUI_HISTORY`).

## New command behavior (C2)

- `noir daemon start --detach` — starts the daemon as a **detached background process** (the command returns; `noir daemon stop` / `noir daemon status` manage it). The daemon record carries `mode:'detached'`.
- `noir context index --force` — forces a **full reindex** (drops all chunks + vectors, re-indexes from scratch). Without `--force`, indexing stays incremental (SHA-256 content-hash, unchanged files skipped).
- `noir init` / `noir create` / `noir sync` — `--dry-run` (alias `--preview`) reports the planned writes (path + mode) to stderr without writing anything.
- Read commands (`context search`, `memory recall`/`sessions`, `task status`) fall back to an **in-process read-only engine** when the daemon is down instead of failing with exit 4. Writes (`task new`/`advance`, `memory save`/`forget`/`consolidate`, `context index`) still require the daemon.
| `--no-tips` | Suppress hints on stderr |
