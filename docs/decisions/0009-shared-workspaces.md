# ADR-0009 — Shared cross-repo workspaces

- **Status:** Accepted
- **Date:** 2026-09-09
- **Spec:** `docs/internal/specs/2026-09-09-shared-workspace-context-design.md`

## Context

Two agent sessions working on the *same product in different repositories*
(backend + frontend) had no way to share live decision context. The existing
architecture deliberately prevents it: the daemon and store are per-project
(`<root>/.noir/store/<projectId>.db`), and 1.12.0-beta.1 hardened cross-project
isolation (`ensureDaemonRunning` reuses a daemon only when its recorded
`projectId` matches the caller's).

## Decision

Introduce a **workspace** — a named, cross-repo sharing unit under
`~/.noir/workspaces/<name>/` (registry.json + store.db + its own daemon record) —
served by **one workspace daemon** (foreground by default, or `--detach`):

- **Default stays stdio.** A repo joins explicitly via
  `noir daemon start --workspace <name>` (founder) or `noir daemon join <name>`;
  `noir workspace leave` restores stdio. Joining writes a `.noir/workspace.json`
  marker + rewrites the repo's host MCP `noir` entry to
  `http://127.0.0.1:<port>/mcp?p=<projectId>`.
- **Multiplexed routing:** the daemon routes `memory_*` + feed tools to the
  shared workspace store, and `context_*`/`workflow_*`/`task_*` to the requesting
  member's own project store (identity from the `?p=` query). A non-member is
  refused; per-DB single-writer is preserved (one process, N handles).
- **Slice boundary:** memory + change feed only. Code search, workflow, and
  team/multi-user stay per-repo / v2.0.
- **Change feed, not content push:** a monotonic cursor + `changes_since` +
  long-poll `await_changes` (in-process waiters). Research (spec §2) shows
  content push into an agent loop is both infeasible cross-host and an
  anti-pattern; signal-only, pull-on-read is the design.
- **Provenance is stamped, never caller-supplied:** `repo` on a workspace
  observation derives from the request `?p=` identity; supersede/forget are
  append-only (status `superseded`/`forgotten`), never destructive.

## Consequences

- Cross-repo sharing works on one machine, localhost-only, with an explicit
  per-repo opt-in; solo-project behavior is unchanged.
- The workspace daemon defaults to never idling out (`workspace.idleTimeoutSec:
  0`); the knob is user-configurable via the `workspace:` config block.
- `memory_capture` is wired as a manual CLI verb (provenance `auto:<hook>`); no
  auto-installed **capture** hooks. (The `claude` host does get an unrelated
  `SessionStart` *context* hook at `noir init` — it bootstraps context, it does
  not capture memory.)
- `noir memory *` in a joined repo routes to the workspace daemon (`?p=`
  identity); `context`/`workflow`/`task` stay per-project. `noir memory
  consolidate` is refused on a shared workspace (a per-project concern).
- Cross-machine / team / multi-user sharing remains v2.0 (see `releases.md`).

## See also

- **User-facing guide:** [Sharing memory across repositories (workspaces)](../how-to/shared-workspaces.md)
