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

A joined repo reaches that daemon through a **stdio bridge**: its host config
names the workspace, and the `noir` command the host spawns resolves the daemon
and authenticates to it. No address and no secret are written into the repo's
config, so nothing there can go stale or leak. (See the
[workspace transport and daemon-routing decision](../decisions/0013-workspace-transport-and-daemon-routing.md)
for why the older URL-based entry was replaced.)

## 0. Prerequisite — initialize both repos

Both repos must be known to Noir before they can start or join a workspace
(running either command in an uninitialized directory fails with
``Noir is not initialized in this directory. Run `noir init` first.``):

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
#   this repo's host MCP config at the workspace through the bridge
```

`noir daemon start --workspace <name>` is **foreground by default** (it blocks
your shell; `Ctrl+C` stops it). Pass `--detach` to background the daemon and
return to the shell. The daemon binds **127.0.0.1** on an **ephemeral
(OS-assigned) port** — there is no fixed port to choose, and nothing you write
down depends on it.

## 2. Join from the other repo (frontend)

```bash
cd /repo-frontend
noir daemon join my-app
# → registers this repo as a member + writes the bridge entry below
```

`join` rewrites only the `noir` entry of the repo's host MCP config; every other
server you added, and every other key on that entry, is preserved. It refuses to
overwrite a config that doesn't look Noir-emitted unless you pass `--force`.
Joining twice is idempotent.

The entry it writes is the ordinary stdio shape, with the workspace name as the
only variable:

```json
{
  "mcpServers": {
    "noir": { "command": "noir", "args": ["mcp", "serve", "--stdio", "--workspace", "my-app"] }
  }
}
```

That is the whole contract. The host starts
`noir mcp serve --stdio --workspace my-app`, and the bridge:

1. reads the workspace's daemon record to find where it is listening,
2. proves through `/health` that the process there really is *that* workspace's
   daemon (never a recycled pid or a stale record),
3. reads the daemon's bearer token itself, and
4. relays every MCP message to `http://127.0.0.1:<port>/mcp?p=<this repo's
   projectId>`, which the daemon uses to authorize the caller as a member.

Nothing about the daemon — its port, its token — appears in the config, so there
is nothing to re-sync after a restart. (`command` is the resolved `noir` shim:
bare `noir` on a standard install, an absolute path when Noir was installed as a
native binary, so GUI MCP clients that do not read your shell profile still find
it.)

Where the config lives depends on the host (set at `noir init --host <id>`):

| Host | Host MCP config file |
|---|---|
| Claude Code (default) | `.mcp.json` |
| AGENTS.md | `.mcp.json` |
| Cursor | `.cursor/mcp.json` |
| Gemini | `.gemini/mcp.json` |
| OpenCode | `opencode.json` |

`join` rewrites the `noir` entry in that file, so the file has to be one of the
`{ "mcpServers": { … } }` hosts — Claude Code, AGENTS.md, Cursor and Gemini all
use that shape and all get the same stdio entry naming the workspace. Claude
Code is the regression anchor.

> **OpenCode is not supported yet.** Its `opencode.json` uses a different shape —
> a top-level `mcp` block with `type`-tagged entries, not `mcpServers` — which
> `join` does not recognize: it refuses the file without `--force`, and
> `--force` would add an `mcpServers` block OpenCode never reads. Treat
> workspaces as Claude-Code-first for now.

**After `join`, restart/reconnect the agent session** in that repo so it
re-reads the rewritten config (Claude Code: `/mcp` reconnect or restart the
session). A session started before the rewrite keeps the old entry.

## 3. What the token protects

The workspace daemon serves the shared store over HTTP, and that transport
authenticates **every** `/mcp` request with a bearer token. The token is the
boundary the daemon checks before it will serve a request: a caller that cannot
present it gets a `401` refusal naming the token file.

- The token is minted **fresh on every daemon start** and written `0600` to
  `~/.noir/daemons/<workspace-name>.token`. A token therefore never outlives the
  daemon that issued it.
- **The bridge and the CLI's own workspace commands are the readers.** Both read
  the token file at connect time and send it in the `Authorization` header; the
  token never reaches a config file, a command line, or a log. You never copy it
  anywhere.
- `/health` stays **token-free**, so liveness probes work — which is exactly
  what lets the bridge and `noir workspace status` check the daemon without a
  credential. Its body carries no secret.
- Membership is checked separately from the token: the `?p=<projectId>` in the
  URL must name a current member, or the daemon refuses the request. A repo that
  never joined is refused.

`noir daemon token` is **project**-scoped — it prints the token for the project
daemon you are running, not a workspace token. There is no user-facing command
for a workspace token, and you do not need one: the bridge reads it for you.

## 4. Share memory

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

## 5. Verify it works

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

## 6. Status, stop, leave

```bash
noir workspace list                  # workspaces on this machine
noir workspace status                # members + daemon liveness (from a joined repo)
noir workspace status my-app         # …or name it explicitly
noir workspace leave                 # this repo stops sharing; entry back to plain stdio
noir workspace stop my-app           # stop the daemon (membership retained)
```

These commands confirm the daemon's identity the same way the bridge does: they
ask `/health` who is listening before they report or signal anything. A record
whose pid is alive but which does not answer as *this* workspace is reported as
not running, and `stop` refuses to signal it rather than risk killing an
unrelated process.

## 7. Restarting the daemon

Restarting the workspace daemon needs no re-join. The entry in every member repo
names the **workspace**, not a port or a token, so it stays correct across any
number of restarts — the next session's bridge resolves the current daemon and
reads the current token on its own.

What a restart does change is any **already-open session**. A running session
holds a live connection to the old process; when the daemon stops, the bridge's
relay closes and the host sees that session end. Reconnect or restart the
session (Claude Code: `/mcp` reconnect) to spawn a fresh bridge against the
restarted daemon.

Start a stopped daemon from any member repo:

```bash
noir daemon start --workspace my-app --detach
```

`noir workspace stop` clears the daemon record; the next `start` writes a fresh
record and a fresh token, which is the token every member's bridge will read.

## 8. Manual capture

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

**"The host says the Noir server failed to start."** The bridge could not resolve
the workspace daemon and exited before relaying anything. The reason it printed
is the diagnosis; match it to the fix:

| Message from the bridge | What it means | What to do |
|---|---|---|
| `no daemon recorded for workspace <name>` | There is no daemon record — the daemon has not been started, or a stop cleared the record. | Start it: `noir daemon start --workspace <name> --detach`. |
| `record exists but the daemon is not answering (pid <pid>)` | A record exists but nothing healthy answers on its port — the process crashed without cleaning up. | Start it again; the fresh start overwrites the stale record. |
| `workspace <name> is recorded on port <port>, but the daemon answering there serves workspace <other>` | The record is stale and the port has been taken over by a different workspace's daemon. | Start this workspace again — the fresh start binds a new ephemeral port and rewrites its own record only. |
| `workspace <name> daemon is answering but its token is unreadable at <path>` | The daemon is up but its `0600` token file is missing or unreadable. | Restart the daemon to mint a fresh token, and check the file's permissions. |
| ``no project identity in <root> — run `noir init` before serving a workspace from here`` | This repo has no `.noir/` identity to authorize as a member. | Run `noir init` here, then reconnect. |

**"A URL with `?p=` answered `400`."** The message
`unexpected query string: this is a project daemon, which serves one project at
/mcp with no query string; a ?p=<projectId> URL belongs to a workspace daemon.`
means a workspace-shaped URL was addressed at a **project** daemon. In a joined
repo you should not be writing URLs at all — the workspace is reached through
the stdio entry. In a repo that joined under the older flow, a stale
`http://…/mcp?p=…` entry is exactly what `noir init --upgrade` migrates to the
bridge entry.

- **Single machine, localhost only.** Sharing across machines/teams is a v2.0
  feature (not in this release).
- **A non-member repo is refused** by the daemon; a repo that never joins is
  byte-for-byte unchanged.
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
  started again (`noir daemon start --workspace my-app`), and a host session
  fails to start its `noir` server while the daemon is down; memory **reads**
  fall back to a read-only pass over the shared store (a
  `degraded: BM25-only` warning is printed).
- **`sync` / `init --force` keep a joined repo joined.** Membership is recorded
  by a marker in the repo, and the entry follows membership — a re-scaffold
  re-emits the workspace entry rather than reverting to plain stdio.
  `noir workspace leave` is the way out.
- **Moving a repo directory or re-cloning it breaks membership** (the registry
  records the repo's absolute path, and a fresh `.noir/` regenerates its
  `ProjectId`). Re-run `noir daemon join my-app` in the moved/cloned repo.
