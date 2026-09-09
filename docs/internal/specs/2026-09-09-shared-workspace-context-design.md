# Shared Workspace Context — Design

> **Status:** approved-for-spec (brainstormed 2026-09-09) — awaiting implementation plan
> **Target:** v1.13.0 (after 1.12.0 stable ships)
> **Capability:** C5 Runtime Infrastructure (extension) + C9 AI Platform Evolution (first concrete slice)
> **Slice id:** `shared-workspace`
> **Requires ADR:** ADR-0009 (new "workspace" top-level concept)

---

## 1. Problem & motivation

Two agent sessions working on the *same product but different repositories* (a backend repo and a frontend repo) have no way to share live context today. The outcome a developer actually wants: the backend session decides an API shape and the frontend session can read that decision from a **running local server** — without generating handoff documents, and without both sessions living in one repo.

The current architecture deliberately prevents cross-repo sharing:

- The daemon and store are **per-project**. The store lives at `<root>/.noir/store/<projectId>.db` and the daemon's store handle is baked in at start time (`packages/daemon/src/store-seam.ts`, `openStoreForDaemon(projectId, root)`).
- **Cross-project isolation was hardened in 1.12.0-beta.1**: `ensureDaemonRunning` reuses a daemon only when its recorded `projectId` matches the caller's, and clears wrong-project records (`packages/daemon/src/ensure.ts`); `noir daemon stop` refuses to operate another project's daemon. Two repos ⇒ two daemons ⇒ two stores ⇒ no sharing.

This spec introduces a **workspace**: an explicit, named, cross-repo sharing unit backed by one detached daemon. Sessions that need sharing join a workspace; everything else keeps the status quo (stdio default, per-project stores, project isolation).

## 2. Research grounding

Two research threads informed this design (web + code, 2026-09-09). Full source lists are in the session notes; the load-bearing findings:

**Transport & push feasibility (MCP).**
- True server→client *content* push into an agent's working loop is **not reliably feasible** in any mainstream host today. Claude Code handles `list_changed` (capability-catalog refresh) but not `resources/updated` content push; the only content-injection path ("channels") is stdio-only, research-preview, org-gated, and buggy. Cursor and VS Code are pull-only.
- The workable cross-host pattern is a **single-writer store + monotonic cursor + `changes_since(cursor)` + long-poll `await_changes(cursor, timeout)`** — one outstanding blocking call per session gives near-push latency with no poll storm and survives MCP's stateless Streamable HTTP model. This mirrors what group-chat and agent-hub MCP servers already ship (`read_notifications` / `sync`).

**Shared agent-memory best practices.**
- **Memory is retrieval, not storage**; keep context windows small and pull the smallest set of high-signal entries at the moment of need (Anthropic, *Effective context engineering*).
- **Deliberate writes at decision boundaries** beat auto-capture-everything; auto-capture of transcripts reproduces context rot and is a privacy surface (Anthropic Claude Code memory docs).
- **Structure at write time drives retrievability**: typed entries with owner/scope/type/status/timestamp and a retrieval-grade description (Claude Code typed notes; mem0 metadata model).
- **Append-only + resolve at retrieval time**, never destructive overwrite; a later write supersedes rather than erases (mem0 v3 rationale; Letta sleep-time compute, arXiv:2504.13171).
- **Daemon stays the single writer.** WAL is necessary but not sufficient — SQLite is single-writer; two processes on one DB file cause "database is locked". All workspace writes must flow through the one daemon.
- **Provenance and scope on every entry**, especially for a *shared* store: source repo, source session, type, status. Cross-scope leakage is how shared stores become useless and dangerous (Microsoft agentic memory safety).
- **Retrieved memory is quoted candidate context, never instructions** — frame recall results as evidence-with-source so a poisoned/stale entry cannot steer behavior (Redis context-poisoning analysis).
- **Background consolidation off the critical path**, proposed changes reviewable/logged, never silently mutating what an agent is about to read.
- **Signal-only notifications**, never content pushes; a "what changed since X" query must always work as the backstop.

## 3. Goals & non-goals

### Goals
1. Two or more agent sessions in **different repos on one machine** share decision memory through **one detached daemon**, with no handoff documents.
2. The **default mode is unchanged**: stdio MCP per session, project-scoped stores. Sharing is an **explicit, per-repo opt-in** (`join`).
3. The shared daemon is an **optimized sharing surface**: memory tools + a near-real-time change feed (`await_changes` long-poll), with write-time provenance (repo, session, type, status).
4. Cross-repo isolation stays strict: a daemon refuses requests from repos that are not workspace members; solo-project behavior is untouched.
5. Wire `noir memory capture` (manual invocation only) so a session can distill a transcript into observations on demand — closing a documented C9 acceptance item.

### Non-goals (this slice)
- Cross-machine / team / multi-user sharing (localhost only) — v2.0 ecosystem.
- Cross-repo **code** search (`context_search` stays per-repo, routed to each repo's own store; no fan-out index).
- Workspace-level workflow / task / skill / artifacts — workflow stays per-ProjectId.
- Auto-capture-by-default / host hooks wiring. Capture is a **manual** CLI verb; the opt-in hooks template already exists and is not changed.
- Content *push* into an agent's context window. We ship a **long-poll change signal**; the agent reads on demand (this is the anti-pattern-safe equivalent, per §2).
- Multi-step host driving / TUI transcript picker (v2.0, ADR-0008).

## 4. Concept: the workspace

A **workspace** is a named sharing unit that spans repositories on one machine.

- **Location:** `~/.noir/workspaces/<name>/` contains:
  - `registry.json` — membership: `{ name, members: [{ projectId, root }], createdAt }`. The registry is the **single source of truth** for who may talk to the workspace daemon. `projectId` is the canonical id each repo resolves from its own root (never a filesystem path as identity — existing invariant).
  - `store.db` — the shared context store (same schema family as a project store; see §7).
  - `daemon.json` — the workspace daemon record (port, pid), stored **outside** any single repo's `.noir/` so no member "owns" the daemon.
- **One daemon per workspace.** The daemon is started detached by any member and stays alive (idle-exit disabled by default in workspace mode, see §6).
- **Membership is explicit.** A repo joins by registering its `projectId`; `leave` removes it and restores that repo's `.mcp.json` to stdio.
- Workspaces are **not** projects. Project-scoped concerns (context index, workflow, task, skills) continue to live in each member's own `.noir/store/<projectId>.db`. The workspace store holds only what the workspace is for: **shared decision memory + its change feed**.

## 5. Topology & lifecycle (CLI surface)

The approved command shape keeps `noir daemon start` as the point of detaching, extended for workspaces:

```
noir daemon start --workspace <name>   # from a repo: create-or-activate workspace, start detached
                                       # workspace daemon, point this repo's .mcp.json at it
noir daemon join <name>                # from another repo: register this repo's projectId as a
                                       # member and point its .mcp.json at the running workspace daemon
noir workspace list                    # workspaces on this machine + member count + daemon state
noir workspace status [name]           # members, daemon pid/port, store path, current cursor
noir workspace leave [name]            # unregister this repo; restore its .mcp.json to stdio
noir workspace stop [name]             # stop the workspace daemon (membership retained)
```

Lifecycle rules:

- `noir daemon start --workspace <name>` in a repo creates the workspace registry (if absent), registers that repo as the **founding member**, starts the detached daemon, and rewrites the repo's host MCP config to an HTTP entry (see below). Subsequent runs in any member repo are idempotent (reuse the running daemon).
- `noir daemon join <name>`: if the workspace daemon is not running, any member repo may start it (the registry is on disk — no ordering dependency on the founder). It registers the caller's `projectId`/`root`, rewrites the caller's host MCP config, and writes a **join marker** `.noir/workspace.json` (`{ "name": "<workspace>" }`) into the repo.
- **CLI routing for joined repos:** the join marker is how CLI memory commands find the workspace. In a repo carrying the marker, `noir memory save|recall|search|sessions|forget|capture` connect to the workspace daemon (adding `?p=<projectId>`), while `context`/`task`/`workflow`/`daemon` CLI commands keep their per-project behavior. `noir workspace leave` removes the marker and restores stdio — without it, the CLI behaves exactly as today (no repo scanning of `~/.noir/workspaces/`).
- `noir daemon stop` (the existing single-project command) must **not** adopt or stop a workspace daemon; a workspace daemon is only stopped via `noir workspace stop` (extend the 1.12 project-gating so the two daemon-record kinds never collide).
- `.mcp.json` rewrite uses the existing adapter seam (`packages/adapters/src/mcp.ts`, `buildMcpServersJson`), which already emits an HTTP entry `{ type: 'http', url }`, and the init URL gate stays localhost-only. **Project identity is carried in the URL**: each member repo's entry points at `http://127.0.0.1:<port>/mcp?p=<its-own-projectId>`.
- Rewrites honor the conflict contract (`onConflict` seam, `assertNotUserOwned`) — a user-edited `.mcp.json` is never clobbered silently.
- A repo leaves (`noir workspace leave`): its `projectId` is removed from `registry.json`, and its `.mcp.json` is restored to the stdio entry. The workspace persists for remaining members.
- **Idle timeout:** the existing per-request daemon idle-exits (`http.ts` idle timer). A workspace daemon must **default to no idle-exit** (it is the thing "running while you develop"); add a `workspace.idleTimeoutSec` config (0 = never) and document it.

## 6. Daemon multiplexing (per-request routing)

Today the daemon opens **one** store handle per lifecycle and every request shares it. In workspace mode the daemon holds:

- **one workspace store handle** (the shared memory + feed), and
- **zero or more member project store handles**, opened lazily and cached, keyed by `projectId`.

Each HTTP request builds a fresh `McpServer` today (stateless Streamable HTTP). In workspace mode the handler reads the `p` query parameter, validates it against the **current** registry, and threads the resolved scope into `ServerContext`:

| Tool family | Routes to |
|---|---|
| `memory_*` (`memory_save`/`recall`/`search`/`sessions`/`forget`) + new feed tools (`changes_since`, `await_changes`) | **workspace store** |
| `context_*`, `workflow_*`, `task_*`, other project tools | the **requesting member's project store** |

Rules:

- **Single-writer invariant holds per database.** The workspace daemon is the only writer process for the workspace store *and* for each member's project store it serves. This is safe (one process, N handles) and must be stated in code comments to prevent a future "second writer" regression.
- **A request whose `p` is not a current member is refused** (extend the 1.12 cross-project isolation test surface: non-member → error envelope, never a fallback to a wrong store).
- `startStdioServer` and the non-daemon path are **unchanged**. A stdio session in a member repo still talks to its own per-session process for project tools; it is **not** a workspace participant (memory writes in stdio go to the project store as today). Participation means being attached to the workspace daemon over HTTP. This keeps the "stdio default; sharing is explicit" contract crisp.
- **Degradation** mirrors the project store: if the workspace store cannot be opened, the daemon starts read-only (`degraded`) and `memory_save`/feed writes short-circuit with a clear envelope (reuse the existing `storeDegraded` threading in `server.ts`).
- `/health` gains `{ workspace: <name>, memberCount }` so `noir workspace status` and reuse probes can verify identity (mirror the pid + projectId guards added in 1.12).

## 7. Data model (workspace store)

The workspace store reuses the existing observation architecture (FTS5 + sqlite-vec + authoritative KV row) from `packages/memory/src/engine.ts`, with two additions: **provenance** and **the change feed**.

### 7.1 Provenance on every observation

Existing `Observation` already carries `project`, `sessionId`, `type`, `ts`, `concepts`, `files`, `source` (`engine.ts`, `saveInternal`). In workspace mode the daemon stamps additional fields (extend the type **open-enum style** — absent on legacy rows, never required on read):

- `repo: { projectId, root? }` — which member repo wrote it (auto-stamped from the `?p=` identity; never caller-supplied).
- `host` — optional host/session label when the caller supplies it (e.g. a session id) — already partly covered by `sessionId`.
- `status: 'active' | 'superseded' | 'forgotten'` (default `'active'`).
- `cursor: number` — the entry's position in the workspace change feed.
- `supersedes?: <observationId>` — when this entry is a correction of another.

**Append-only discipline:** a correction is a *new* observation with `supersedes` set; the daemon flips the target's `status` to `'superseded'`. Nothing destructive is rewritten. `memory_forget` marks `status: 'forgotten'` (hides from default retrieval) rather than deleting — explicit and reversible at the store level.

### 7.2 The change feed

A monotonic cursor is the workspace's single ordering authority:

- A counter `workspace:cursor` in the KV row set, incremented once per mutation (save / supersede / forget); every affected observation is stamped with the new value.
- Feed entries are the **minimal denormalized projection** the search layer already writes (`docs.meta`) plus `status` and `repo.projectId` — never full content. The authoritative row stays in KV; full content is fetched on demand (token-efficiency lemma from §2).
- Because the daemon is one process, `await_changes` is implemented with **in-process waiters**: each pending long-poll registers on the mutation path and is woken once the cursor advances past its starting point. No polling, no cross-process signalling, no external broker.

## 8. MCP tool surface

### 8.1 Existing tools (workspace-aware)

`memory_save`, `memory_recall`, `memory_search`, `memory_sessions`, `memory_forget` operate on the **workspace store** when the request is a workspace member (§6). Two behavior notes:

- **Retrieval framing (poisoning mitigation):** update the tool descriptions so recall/search results are presented as *sourced evidence* (each hit shows `repo.projectId` + session + ts + status) rather than unlabelled facts the agent is expected to treat as truth. This is a **description-level** change plus a stable result shape — the store does not change its recall semantics.
- **Superseded handling:** default recall/search exclude `status: 'superseded' | 'forgotten'`; add an `includeSuperseded` flag for audit.

`memory_save` gains an optional `supersedes` input (see §7.1). Tool descriptions gain a one-line "in a workspace this writes to the shared store" note so the agent knows the write is visible to joined sessions.

### 8.2 New tools (feed)

- `changes_since(cursor: number) → { ok, cursor, changes: FeedEntry[] }` — non-blocking; returns entries (id, cursor, kind: `save|supersede|forget`, repo, type, one-line summary) with cursor above the caller's, and the current high-water cursor. FeedEntry summaries are bounded (~120 chars) — never full content.
- `await_changes(cursor: number, timeoutMs: number ≤ 25000) → same shape, + timedOut` — long-poll; resolves as soon as the workspace cursor advances, or returns the current cursor + empty changes on timeout so the caller can advance and re-arm. `timeoutMs` is capped at 25 s to sit under common MCP client request timeouts.

### 8.3 Server instructions

In workspace mode the MCP server sets a short `instructions` string (surfaced to the host agent at connect) telling it the sharing protocol: *"This server is a shared workspace. memory_save writes are visible to all joined sessions. At the start of a turn and after your own writes, call `changes_since`/`await_changes` to see new context from other sessions."* Agent-facing conventions are the practical substitute for a protocol push (§2).

## 9. `noir memory capture` (manual)

Close the documented gap (`docs/roadmap/backlog.md` "The `memory capture` command does not exist yet"; C9 acceptance in `capability-09-platform-evolution.md`).

- The pure mapper already ships: `packages/memory/src/capture.ts` exports `toSaveInput` (CapturePayload → SaveInput, no I/O, no LLM) and `captureSource` is explicitly documented as the provenance tag for "a dedicated `noir memory capture` command (S9)".
- Wire a CLI verb `noir memory capture [file|-]` that reads a transcript/notes payload (or stdin), maps it through `toSaveInput`, and saves via the normal daemon path — tagging provenance as `captureSource` (`'auto:<hook>'`) rather than `'explicit'`.
- **Manual only.** `noir init`/`sync` never install hooks; the opt-in hooks template is unchanged. This spec adds **no** auto-capture.

## 10. Security & isolation

- **Localhost only.** The daemon binds `127.0.0.1`; the init/join URL gate rejects non-localhost. Auth token on the transport stays a backlog item (out of scope), but the workspace adds its own boundary: **membership in `registry.json` is mandatory** — a non-member `?p=` is refused, so a stray local client cannot read or write the shared store.
- **Provenance is stamped, not accepted.** `repo.projectId` is derived from the request URL identity, never from the caller's payload, so an entry cannot claim a false origin.
- **Write trust boundary.** Tool descriptions tell the agent that memory content is data (quoted candidate context), not instructions; nothing in the store can override daemon/session operational rules (description-level + instructions-string level, per §8).
- **No secrets / chain-of-thought policy** applies to capture: `noir memory capture` is for decision summaries the user chooses to distill; no raw transcript flooding.

## 11. Error handling & degradation

| Situation | Behavior |
|---|---|
| Non-member `?p=` hits the workspace daemon | Refused with a clear envelope ("not a member of workspace <name>"); never a fallback store |
| Workspace daemon down; member session calls memory/feed | CLI reads degrade to read-only in-process project store (existing fallback); workspace writes fail with explicit error + `noir workspace status` guidance |
| `.mcp.json` user-edited at join/leave time | Conflict contract honored; never clobbered; clear instruction on the expected shape |
| `leave` last member | Workspace daemon stopped; registry kept (or removed on explicit flag) — membership is the only thing removed |
| `noir daemon stop` (single-project) inside a member repo | Refuses to touch the workspace daemon (record kinds are disjoint); user is told to use `noir workspace stop` |
| Store lock / FS failure on workspace store | Same degraded read-only fallback as project stores; honest `memory_save` short-circuit |

## 12. Testing plan (offline — never needs network or a key)

Standing rule: **every behavior ships with a regression test.** New test files, all in the offline suite:

1. `daemon/test/workspace-registry.test.ts` — registry create/join/leave; membership is the identity gate; non-member refused; record kinds (project vs workspace daemon) never collide.
2. `daemon/test/workspace-routing.test.ts` — same daemon serves memory_* from the workspace store and context_*/project tools from each member's own store; a `?p=` of repo A never sees repo B's project store.
3. `daemon/test/workspace-feed.test.ts` — cursor monotonicity; `changes_since` ordering + summary projection; `await_changes` wakes on a write from a *different* client within ms; timeout path returns current cursor; supersede/forget produce feed entries and flip status.
4. `daemon/test/workspace-concurrency.test.ts` — **two+ concurrent MCP clients** over Streamable HTTP against one workspace daemon: interleaved writes are visible to both, ordered by cursor, no lock errors (this is the previously-untested multi-client claim).
5. `cli/test/workspace-commands.test.ts` — start/join/list/status/leave; `.mcp.json` HTTP rewrite per member (`?p=<own id>`), restore-to-stdio on leave, conflict contract honored; CLI memory routing via the join marker (marker present → workspace daemon; absent → per-project behavior unchanged).
6. `cli/test/memory-capture.test.ts` — `noir memory capture` maps a payload through `toSaveInput` and persists with `captureSource` provenance.
7. **Regression anchors:** bare `noir init` remains byte-identical; existing daemon cross-project isolation tests stay green; docs validation stays green.

## 13. Documentation plan (user-facing accuracy)

The slice ships with docs that describe the **real, shipped commands** — no documentation drift (CLAUDE.md convention). Files identified by a docs inventory (2026-09-09):

- **New:** `docs/how-to/shared-workspaces.md` — the user-facing guide for using the daemon for context sharing across repos: the exact commands (`noir daemon start --workspace`, `noir daemon join`, `noir workspace list/status/leave/stop`), the two-session BE/FE scenario, and the note that the agent should call `changes_since`/`await_changes` at turn boundaries.
- **Update `docs/getting-started.md`** — where `noir daemon`/MCP transport is currently explained, add the "share context across repos" path + pointer to the how-to.
- **Update `docs/reference/cli.md`** — new verbs/flags (`daemon start --workspace`, `daemon join`, `workspace *`, `memory capture`).
- **Update `docs/reference/mcp-tools.md`** — the regenerated tool list incl. `changes_since`, `await_changes`, and the workspace-aware descriptions of the memory tools.
- **Update `docs/reference/config.md`** — `workspace.*` config (idle-timeout); it is self-maintaining (`.describe()`-driven), so regen in the same checkpoint.
- **Update `docs/explanation/architecture.md`** — the workspace concept, daemon multiplexing, and the "one writer per DB" invariant in the architecture narrative.
- **Roadmap:** `docs/roadmap/STATUS.md` (active slice), `docs/roadmap/releases.md` (v1.13.0 target), `docs/roadmap/backlog.md` (move the event-bus item → resolved-by-`await_changes`; close the `memory capture` gap), `capability-09` (mark the auto-capture slice's CLI part done).
- **CHANGELOG.md** at ship time.
- **Docs ADR:** record the decision as `docs/decisions/0009-...md` (extract §4–§8 into ADR form).

## 14. Implementation slices (for the plan phase)

Planned as sequential slices, each with its own spec-level acceptance:

- **W1 — Workspace core:** `~/.noir/workspaces/<name>/` registry, `daemon.json` record (workspace kind), `daemon start --workspace` founding flow, daemon-record isolation from project records. Tests: registry + record isolation.
- **W2 — Multiplexed daemon + provenance:** `?p=` identity parsing + membership validation; workspace store handle; lazy per-member project handles; routing table (§6); provenance stamping (§7.1). Tests: routing + non-member refusal.
- **W3 — Change feed:** cursor counter, feed projection, `changes_since` + `await_changes` (in-process waiters), supersede/forget semantics, server `instructions`. Tests: feed + wake-on-write.
- **W4 — CLI completion:** `join`, `workspace list/status/leave/stop`, `.mcp.json` HTTP rewrite/restore through the adapter seam with conflict contract, and the `.noir/workspace.json` join marker + CLI memory routing. Tests: commands + rewrite/restore + routing.
- **W5 — `noir memory capture`:** CLI verb wired through the existing `capture.ts` mapper. Tests: mapper end-to-end.
- **W6 — Concurrency hardening + docs:** two-client concurrency suite; the documentation plan in §13; ADR-0009.

## 15. Acceptance criteria

The slice is done when, all offline and on one machine:

1. Two repos joined to one workspace: a `memory_save` from a session attached in repo A is returned by `memory_recall`/`memory_search` from a session attached in repo B, with correct `repo.projectId` provenance — **no handoff document involved**.
2. An `await_changes` long-poll held by repo B's session returns within milliseconds of repo A's `memory_save`, without busy-polling.
3. A session in a non-member repo (or a bare `?p=` for a non-member) is refused by the workspace daemon; single-project behavior (`noir init` default, project stores, project-gated daemon commands) is byte-for-byte unchanged.
4. `noir memory capture` persists a distilled payload with `captureSource` provenance.
5. `.mcp.json` HTTP rewrite on join and stdio restore on leave honor the conflict contract (no silent clobber).
6. Full gate green: `pnpm lint` → `build` → `typecheck` → `test` → `docs:validate`.
7. The documentation plan in §13 is applied in the same checkpoint as the code — user-facing commands describe only shipped reality.

## 16. Resolved design decisions (record for ADR-0009)

| Question | Decision |
|---|---|
| Default mode | Stays stdio; sharing is explicit per-repo join |
| Sharing unit | Named **workspace** spanning repos, registry + store under `~/.noir/workspaces/<name>/` |
| Memory scope in a joined repo | Workspace-only (memory tools route to the workspace store) |
| Slice boundary | Memory + change feed only; code search, workflow, team/multi-user stay per-repo / v2.0 |
| Notification | Long-poll `await_changes` + `changes_since`; **no** content push (§2 evidence) |
| Capture | `noir memory capture`, manual only, through the existing mapper |
| Identity on transport | Project identity via URL query `?p=<projectId>`, validated against the registry each request |
