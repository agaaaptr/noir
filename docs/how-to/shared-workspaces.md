# Sharing context across repositories (workspaces)

Two agent sessions in **different repos** (e.g. a backend repo and a frontend
repo) can share decision memory through **one detached daemon** — no handoff
documents. This is a **workspace**: a named, cross-repo sharing unit.

The default transport stays **stdio**; nothing changes unless a repo explicitly
joins. A workspace daemon binds `127.0.0.1` and serves the **shared** memory
store (`~/.noir/workspaces/<name>/store.db`), while each member repo keeps its
own project store for context/workflow/tasks.

## 1. Start a workspace (from the backend repo)

```bash
cd /repo-backend
noir daemon start --workspace my-app
# → creates the workspace, joins this repo as the founder,
#   starts the detached daemon, points this repo's .mcp.json at it
```

Use `--detach` to background the daemon and return to the shell:

```bash
noir daemon start --workspace my-app --detach
```

## 2. Join from the other repo (frontend)

```bash
cd /repo-frontend
noir daemon join my-app
# → registers this repo as a member + points its .mcp.json at the daemon
```

`join` rewrites only the `noir` entry in the repo's host MCP config (e.g.
`.mcp.json`) to `http://127.0.0.1:<port>/mcp?p=<projectId>`; every other server
you added is preserved. It refuses to overwrite a config that doesn't look
Noir-emitted unless you pass `--force`.

## 3. Share context

Both sessions now attach to the same daemon. Memory writes are visible to the
other session (provenance is stamped with the originating repo, never
caller-supplied):

- **Backend** writes a decision:
  `memory_save { content: "GET /users returns {items: User[]}; pagination uses page, not offset", type: "architecture" }`
- **Frontend** reads it on demand:
  `memory_recall { query: "users list pagination" }`
- To *notice* what the other session just recorded, call
  `changes_since { cursor }` (pull) or `await_changes { cursor, timeoutMs }`
  (long-poll — resolves as soon as a new entry lands). The daemon tells every
  attached agent to check these at turn boundaries.

Corrections are append-only: `memory_save { supersedes: "<older-id>", ... }`
marks the target `superseded` (hidden by default; see it with
`memory_recall { includeInactive: true }`).

## 4. Status, stop, leave

```bash
noir workspace list                  # workspaces on this machine
noir workspace status                # members + daemon liveness (from a joined repo)
noir workspace status my-app         # …or name it explicitly
noir workspace leave                 # this repo stops sharing; .mcp.json back to stdio
noir workspace stop my-app           # stop the daemon (membership retained)
```

## 5. Manual capture

Distill a transcript/notes file into memory without auto-installed hooks
(capture is always manual):

```bash
noir memory capture session-notes.md
cat notes.md | noir memory capture
noir memory capture --content "Frontend expects the /users contract from backend #42"
```

`noir init`/`sync` never install hooks — capture is an explicit action.

## Notes

- **Single machine, localhost only.** Sharing across machines/teams is a v2.0
  feature (not in this release).
- **A non-member repo is refused** by the daemon; a repo that never joins is
  byte-for-byte unchanged.
- A workspace daemon never idles out (it stays up while you develop). Stop it
  explicitly with `noir workspace stop`.
