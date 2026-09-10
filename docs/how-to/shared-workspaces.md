# Sharing memory across repositories (workspaces)

Two agent sessions in **different repos** (e.g. a backend repo and a frontend
repo) can share **decision memory** through **one workspace daemon** — no
handoff documents. A **workspace** is a named, cross-repo sharing unit.

> **What is shared — and what is not.** A workspace shares a *memory store*:
> explicit `memory_save` / `memory capture` writes, explicit
> `memory_recall` / `memory_search` reads, and a bounded change feed
> (`changes_since` / `await_changes`). It does **not** share live agent
> conversations, transcripts, context windows, or the project-local
> `context`/`workflow`/`task` state — each repo keeps its own. Nothing is
> pushed into an agent's context; the other session pulls on demand.

The default transport stays **stdio**; nothing changes unless a repo explicitly
joins. A workspace daemon binds `127.0.0.1` and serves the **shared** memory
store (`~/.noir/workspaces/<name>/store.db`), while each member repo keeps its
own project store for context/workflow/tasks.

## 0. Prerequisite — initialize both repos

Both repos must be known to Noir before they can start or join a workspace
(running either command in an uninitialized directory fails with
`Noir is not initialized in this directory. Run `noir init` first.`):

```bash
cd /repo-backend && noir init
cd /repo-frontend && noir init
```

`noir init` scaffolds `.noir/` and emits the host wiring (for Claude Code, a
stdio `.mcp.json` `noir` entry). It is safe to re-run.

## 1. Start a workspace (from the backend repo)

```bash
cd /repo-backend
noir daemon start --workspace my-app --detach
# → creates the workspace (~/.noir/workspaces/my-app/),
#   registers this repo as the founder member, and points
#   this repo's .mcp.json at the workspace daemon
```

`noir daemon start --workspace <name>` is **foreground by default** (it blocks
your shell; `Ctrl+C` stops it). Pass `--detach` to background the daemon and
return to the shell. The daemon binds **127.0.0.1** on an **ephemeral
(OS-assigned) port** — there is no fixed port to choose.

## 2. Join from the other repo (frontend)

```bash
cd /repo-frontend
noir daemon join my-app
# → registers this repo as a member + points its .mcp.json at the daemon
```

`join` rewrites only the `noir` entry of the repo's host MCP config to
`http://127.0.0.1:<port>/mcp?p=<projectId>`; every other server you added is
preserved. It refuses to overwrite a config that doesn't look Noir-emitted
unless you pass `--force`. Joining twice is idempotent.

Where the config lives depends on the host (set at `noir init --host <id>`):

| Host | Config file rewritten by `join` |
|---|---|
| Claude Code (default) | `.mcp.json` |
| AGENTS.md | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| Gemini | `.gemini/mcp.json` |
| OpenCode | `opencode.json` |

> The HTTP `{ "type": "http", "url": "…" }` entry is verified against **Claude
> Code** (the regression anchor). Cursor and Gemini write their own file but
> their remote-MCP shape is not yet verified; OpenCode refuses a workspace join
> without `--force` and does not yet consume the emitted shape — treat
> workspaces as Claude-Code-first for now.

**After `join`, restart/reconnect the agent session** in that repo so it
re-reads the rewritten config (Claude Code: `/mcp` reconnect or restart the
session). A session started before the rewrite keeps the old stdio entry.

## 3. Share memory

Both sessions now attach to the same daemon. From **inside** an agent session,
the agent calls the MCP tools; from your **shell**, you use the `noir` CLI.
Both write to and read from the same shared store:

```bash
# backend repo — write a decision
noir memory save --content "GET /users returns {items: User[]}; pagination uses page, not offset" --type architecture

# frontend repo — read it on demand
noir memory recall "users list pagination"
```

`noir memory save --type` accepts `pattern | preference | architecture | bug |
workflow | fact | decision`. Provenance is stamped with the originating repo,
never caller-supplied. To *notice* what the other session just recorded, the
agent calls `changes_since { cursor }` (pull) or
`await_changes { cursor, timeoutMs }` (long-poll) — MCP tools, not CLI verbs.

Corrections are append-only: `memory_save { supersedes: "<older-id>", ... }`
marks the target `superseded` (hidden by default; see it with
`memory_recall { includeInactive: true }`).

## 4. Verify it works

The fastest end-to-end check: write from one repo, read from the other.

```bash
cd /repo-backend && noir memory save --content "contract: /users → {items}" --type architecture
cd /repo-frontend && noir memory recall "contract users"   # should return the backend's entry
```

Confirm both repos are members of the same daemon:

```bash
noir workspace list     # "my-app — 2 member(s), running"
noir workspace status   # members + daemon liveness
```

> Use `noir workspace status`, **not** `noir daemon status` — the latter reports
> only the per-project daemon and says "not running" even while the workspace
> daemon is live and serving the repo.

## 5. Status, stop, leave

```bash
noir workspace list                  # workspaces on this machine
noir workspace status                # members + daemon liveness (from a joined repo)
noir workspace status my-app         # …or name it explicitly
noir workspace leave                 # this repo stops sharing; .mcp.json back to stdio
noir workspace stop my-app           # stop the daemon (membership retained)
```

## 6. Manual capture

Distill a transcript/notes file into memory without auto-installed hooks
(capture is always manual):

```bash
noir memory capture session-notes.md
cat notes.md | noir memory capture
noir memory capture --content "Frontend expects the /users contract from backend #42"
```

`noir init`/`sync` never install **memory-capture** hooks — capture is an
explicit action. (The `claude` host does get an unrelated `SessionStart`
*context* hook at `noir init` — that bootstraps project context, it does not
capture memory.)

## Notes & troubleshooting

- **Single machine, localhost only.** Sharing across machines/teams is a v2.0
  feature (not in this release).
- **A non-member repo is refused** by the daemon; a repo that never joins is
  byte-for-byte unchanged.
- **The port changes on every restart** (ephemeral). When the daemon restarts,
  other members' `.mcp.json` still point at the stale port — re-run
  `noir daemon join my-app` in each member repo to re-sync. `join` is the only
  re-sync path.
- **`noir sync` / `noir init --force` revert `.mcp.json` to stdio** (the
  scaffold engine is not workspace-aware). If you re-sync a joined repo, run
  `noir daemon join my-app` again afterwards.
- **`noir daemon status` is misleading** in a joined repo — see the note in
  "Verify it works".
- A workspace daemon defaults to never idling out (`workspace.idleTimeoutSec: 0`
  — set a positive value under `workspace:` in `.noir/config.yml` to auto-stop it
  after N idle seconds). Stop it explicitly with `noir workspace stop`.
- In a joined repo, `noir memory recall|save|capture|sessions|forget` route to
  the workspace daemon; `context`/`workflow`/`task` commands keep the project
  daemon. `noir memory consolidate` is **not supported** on a shared workspace
  (consolidation is a per-project concern) and is refused with a clear message.
- After `noir workspace stop`, memory **writes** fail until the daemon is
  restarted (start it again, or `noir daemon join my-app` from a member);
  memory **reads** degrade to BM25-only (a `degraded: BM25-only` warning is
  printed).
- **Moving a repo directory or re-cloning it breaks membership** (the registry
  records the repo's absolute path, and a fresh `.noir/` regenerates its
  `ProjectId`). Re-run `noir daemon join my-app` in the moved/cloned repo.
