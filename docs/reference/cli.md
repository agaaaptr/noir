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
  context                           context engine
  memory                            memory engine
  skills                            builtin skills
  task                              workflow task control
  install|migrate [options] [spec]  install Noir via the native managed-Node
                                    path (or migrate from another install
                                    method)
  update [options] [spec]           update Noir to the latest version via the
                                    active install method
  handoff [options]                 emit a ready-to-paste host handoff prompt
  wrap [options]                    session-end alias for `noir handoff`
  release [options] [version]       guided release orchestrator over the
                                    patch-release flow
  tui                               interactive Ink dashboard (host · phase ·
                                    daemon + /command dispatch)
  palette                           fuzzy command palette — run any noir
                                    command (Ink)
  run [options] [prompt...]         ask the host agent a question and print the
                                    answer
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
| `--no-tips` | Suppress hints on stderr |
