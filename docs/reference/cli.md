# CLI Command Reference

> Auto-generated from the built CLI: the root `noir --help`, then
> `noir <command> --help` for every command in the tree.

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
  workspace                         shared cross-repo workspaces
  doctor [options]                  environment + project health
  status                            project + daemon + workflow + store
                                    snapshot
  env                               which configuration is in effect and where
                                    each value comes from
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
| `--cwd <path>` | Working directory |
| `--tui` / `--no-tui` | Advisory routing for bare `noir` |
| `--no-tips` | Suppress hints on stderr |

## Commands

### noir init

**Usage:** `noir init [options]`

scaffold Noir in the current project (.noir/, .mcp.json, CLAUDE.md, skills)

| Flag | Description |
|---|---|
| `--transport <transport>` | stdio \| streamable-http (default: stdio) (default: "stdio") |
| `--url <url>` | streamable-http daemon URL (localhost only) |
| `--upgrade` | run scaffold migrations before re-emitting (re-run on an existing project) |
| `--force` | re-scaffold even if already initialized (bypasses the already-init no-op) |
| `--dry-run` | report planned writes without writing anything |
| `--preview` | alias for --dry-run |
| `--host <id>` | target agentic CLI (default: the host in .noir/config.yml, else claude) (choices: "claude", "agents-md", "gemini", "cursor", "opencode") |

### noir create

**Usage:** `noir create [options] [dir]`

bootstrap the Noir AI layer in a new or empty directory

| Flag | Description |
|---|---|
| `--transport <transport>` | stdio \| streamable-http (default: stdio) (default: "stdio") |
| `--url <url>` | streamable-http daemon URL (localhost only) |
| `--force` | re-scaffold even if already initialized (bypasses the already-init no-op) |
| `--dry-run` | report planned writes without writing anything |
| `--preview` | alias for --dry-run |
| `--host <id>` | target agentic CLI (default: claude) — drives host-side emission (choices: "claude", "agents-md", "gemini", "cursor", "opencode") |

### noir sync

**Usage:** `noir sync [options]`

re-emit Noir managed files (.mcp.json, CLAUDE.md blocks, NOIR.md brief, ignores) + skills

| Flag | Description |
|---|---|
| `--force` | overwrite differing regenerated files without prompting (bypasses the conflict menu) |
| `--merge` | three-way merge managed regions (default since 1.3.0; flag kept for compatibility) |
| `--dry-run` | report planned writes without writing anything |
| `--preview` | alias for --dry-run |
| `--no-merge-regions` | strip-replace managed regions (discard hand-edits inside <!-- noir:* --> markers) |
| `--host <id>` | override the configured host (advanced; default reads .noir/config.yml) (choices: "claude", "agents-md", "gemini", "cursor", "opencode") |

### noir mcp

**Usage:** `noir mcp [options] [command]`

MCP server control

### noir mcp serve

**Usage:** `noir mcp serve [options]`

run the Noir MCP server (stdio, or via the shared daemon)

| Flag | Description |
|---|---|
| `--stdio` | force the stdio transport |

### noir daemon

**Usage:** `noir daemon [options] [command]`

control the Noir daemon

### noir daemon start

**Usage:** `noir daemon start [options]`

start the Noir daemon (foreground, or background with --detach)

| Flag | Description |
|---|---|
| `--detach` | run the daemon in the background and exit |
| `--workspace <name>` | start a shared cross-repo workspace daemon instead |
| `--force` | overwrite a non-Noir .mcp.json entry (--workspace only) |

### noir daemon join

**Usage:** `noir daemon join [options] <name>`

join a shared workspace from this repo

| Flag | Description |
|---|---|
| `--force` | overwrite a non-Noir .mcp.json entry |

### noir daemon stop

**Usage:** `noir daemon stop [options]`

stop the Noir daemon

### noir daemon status

**Usage:** `noir daemon status [options]`

report daemon pid/uptime/mode (exit 4 if not running)

### noir daemon token

**Usage:** `noir daemon token [options]`

print the daemon bearer token to stdout (for a host headersHelper)

### noir daemon restart

**Usage:** `noir daemon restart [options]`

stop then start the daemon

| Flag | Description |
|---|---|
| `--detach` | run the daemon in the background and exit |

### noir workspace

**Usage:** `noir workspace [options] [command]`

shared cross-repo workspaces

### noir workspace list

**Usage:** `noir workspace list [options]`

list workspaces on this machine

### noir workspace status

**Usage:** `noir workspace status [options] [name]`

members + daemon liveness for a workspace

### noir workspace leave

**Usage:** `noir workspace leave [options]`

leave the workspace this repo joined (restore stdio)

| Flag | Description |
|---|---|
| `--force` | overwrite a non-Noir .mcp.json entry |

### noir workspace stop

**Usage:** `noir workspace stop [options] [name]`

stop a workspace daemon (membership retained)

### noir doctor

**Usage:** `noir doctor [options]`

environment + project health

| Flag | Description |
|---|---|
| `--dedup` | scan host-context + .noir/ docs for semantic near-duplicates (loads the local embedder) |

### noir status

**Usage:** `noir status [options]`

project + daemon + workflow + store snapshot

### noir env

**Usage:** `noir env [options]`

which configuration is in effect and where each value comes from

### noir context

**Usage:** `noir context [options] [command]`

context engine

### noir context search

**Usage:** `noir context search [options] <query>`

hybrid search over the indexed context

| Flag | Description |
|---|---|
| `--limit <n>` | max results (default: "10") |

### noir context index

**Usage:** `noir context index [options]`

(re)index project files into the context store

| Flag | Description |
|---|---|
| `--path <p>` | path to index (repeatable) (default: []) |
| `--force` | force a full reindex (drop all chunks+vectors, re-index from scratch) |

### noir context status

**Usage:** `noir context status [options]`

index freshness + counts

### noir memory

**Usage:** `noir memory [options] [command]`

memory engine

### noir memory recall

**Usage:** `noir memory recall [options] <query>`

recall memories for a query

| Flag | Description |
|---|---|
| `--limit <n>` | max results (default: "10") |

### noir memory save

**Usage:** `noir memory save [options]`

save an observation to long-term memory

| Flag | Description |
|---|---|
| `--content <text>` | memory content (prompted interactively if omitted) |
| `--type <type>` | observation type (pattern \| preference \| architecture \| bug \| workflow \| fact \| decision) |
| `--files <files>` | comma-separated related file paths |

### noir memory sessions

**Usage:** `noir memory sessions [options]`

list recent memory sessions

### noir memory forget

**Usage:** `noir memory forget [options] <ids...>`

delete one or more memories by id

### noir memory consolidate

**Usage:** `noir memory consolidate [options]`

consolidate memories into a derived lesson (provider-explicit)

| Flag | Description |
|---|---|
| `--types <types>` | comma-separated observation types to consolidate |
| `--limit <n>` | cap on candidate observations |

### noir memory capture

**Usage:** `noir memory capture [options] [file]`

distill a transcript/notes file (or stdin) into a memory (manual)

| Flag | Description |
|---|---|
| `--content <text>` | inline distilled content |
| `--event-type <type>` | capture hook label (defaults to Stop) |

### noir skills

**Usage:** `noir skills [options] [command]`

builtin skills

### noir skills list

**Usage:** `noir skills list [options]`

list installed Noir skills

### noir skills sync

**Usage:** `noir skills sync [options]`

re-emit skills to the host skills dir

### noir skills lint

**Usage:** `noir skills lint [options]`

structural quality gate over the shipped pack

### noir skills registry

**Usage:** `noir skills registry [options]`

emit the runtime-derived skill registry

### noir task

**Usage:** `noir task [options] [command]`

workflow task control

### noir task new

**Usage:** `noir task new [options]`

start a new workflow task

| Flag | Description |
|---|---|
| `--slug <slug>` | task slug |
| `--mode <mode>` | full \| quick |
| `--class <taskClass>` | task class (feature/epic/enhancement/bugfix/spike/quick-task/refactor) — drives the PRD gate |

### noir task status

**Usage:** `noir task status [options] [id]`

active (or named) task status

### noir task advance

**Usage:** `noir task advance [options]`

advance the active task to the next phase

| Flag | Description |
|---|---|
| `--to <phase>` | target phase |
| `--force <reason>` | force the gate with a reason |
| `--skip` | record the landing gate as skipped (advance continues) |
| `--no-artifacts` | skip the document-phase artifact writes at done |

### noir task next

**Usage:** `noir task next [options]`

suggest the next phase + applicable skill

### noir task decompose

**Usage:** `noir task decompose [options] <capability>`

decompose a capability into an implementation plan

| Flag | Description |
|---|---|
| `--out <path>` | output path for the plan JSON |

### noir task verify

**Usage:** `noir task verify [options]`

run configured verify checks and submit evidence to the verify gate

| Flag | Description |
|---|---|
| `--check <name>` | restrict to a named check (repeatable) (default: []) |

### noir task research

**Usage:** `noir task research [options] [id]`

list research findings for the active (or named) task

### noir task research-record

**Usage:** `noir task research-record [options]`

record a research finding for the active (or named) task

| Flag | Description |
|---|---|
| `--type <type>` | assumption \| discovery \| decision \| grounding-fact |
| `--text <text>` | finding text (capped) |
| `--source <ref>` | evidence/citation (required unless grounding-fact) |
| `--task <id>` | task id (defaults to active) |

### noir task resume

**Usage:** `noir task resume [options] [id]`

resume the active (or named) in-flight/blocked task

| Flag | Description |
|---|---|
| `--prompt <text>` | a continue instruction to surface in the briefing |

### noir task block

**Usage:** `noir task block [options] <reason>`

mark the active (or named) task blocked with a reason

| Flag | Description |
|---|---|
| `--task <id>` | task id (defaults to active) |

### noir task abandon

**Usage:** `noir task abandon [options]`

abandon the active (or named) task (terminal, confirmed)

| Flag | Description |
|---|---|
| `--task <id>` | task id (defaults to active) |

### noir install

**Usage:** `noir install|migrate [options] [spec]`

install Noir via the native managed-Node path (or migrate from another install method)

| Flag | Description |
|---|---|
| `--list` | list detected install methods |
| `--uninstall-prev` | after a successful migrate, uninstall the previous install method |
| `--dismiss` | dismiss the migration banner for the current version (persists in install.json) |

### noir update

**Usage:** `noir update [options] [spec]`

update Noir to the latest version via the active install method

| Flag | Description |
|---|---|
| `--check` | check for a new version without changing anything |

### noir handoff

**Usage:** `noir handoff [options]`

emit a ready-to-paste host handoff prompt

| Flag | Description |
|---|---|
| `--write` | persist to .noir/handoff/HO-<NNNN>-<id>.md (gitignored) |

### noir wrap

**Usage:** `noir wrap [options]`

session-end alias for `noir handoff`

| Flag | Description |
|---|---|
| `--write` | persist to .noir/handoff/HO-<NNNN>-<id>.md (gitignored) |

### noir release

**Usage:** `noir release [options] [version]`

guided release orchestrator over the patch-release flow

| Flag | Description |
|---|---|
| `--channel <channel>` | beta (default) \| stable |
| `--dry-run` | print the checklist without executing any steps |

### noir tui

**Usage:** `noir tui [options]`

interactive Ink dashboard (host · phase · daemon + /command dispatch)

### noir palette

**Usage:** `noir palette [options]`

fuzzy command palette — run any noir command (Ink)

### noir run

**Usage:** `noir run [options] [prompt...]`

ask the host agent a question and print the answer

| Flag | Description |
|---|---|
| `--host <id>` | host to drive (default claude) (choices: "claude", "agents-md", "gemini", "cursor", "opencode") |
| `--command <binary>` | custom host binary (e.g. claude-work) |
| `--profile <name>` | use a named run profile (run.profiles in .noir/config.yml) |
| `--list-profiles` | list configured run profiles and exit |
