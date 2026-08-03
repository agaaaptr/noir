# Capability 5 — Runtime Infrastructure & Local Daemon

> **Status:** Shipped — daemon + store + transports are live; detach/auth/workers are research

## Overview

The local runtime behind the Noir CLI: an `@noir-ai/daemon` MCP server with a single-writer embedded store and stdio + Streamable HTTP transports, backed by an `@noir-ai/store` built on SQLite/FTS5/sqlite-vec. The daemon owns the project database and exposes the full MCP tool surface; the CLI talks to it over Streamable HTTP, and a read-only fallback keeps reads working when the store cannot be opened for writes.

## Shipped today

- **Foreground HTTP daemon** on 127.0.0.1: `GET /health` plus the `/mcp` Streamable HTTP route; records itself in `~/.noir/daemon.json`; idle-timeout shutdown and SIGINT/SIGTERM cleanup ([http.ts](../../packages/daemon/src/http.ts), [lifecycle.ts](../../packages/daemon/src/lifecycle.ts)).
- **Single-writer discipline**: the store is opened once per serve lifecycle and the same handle is reused across requests — no per-request re-open races ([store-seam.ts](../../packages/daemon/src/store-seam.ts)).
- **Two transports, one server**: both stdio and Streamable HTTP expose the same `McpServer` ([stdio.ts](../../packages/daemon/src/stdio.ts)).
- **Read-only FS fallback**: on writable-open failure the store reopens `{readonly:true}`; reads keep working, writes throw honest errors.
- **`store_status` tool**: reports ok / projectId / docCount / vecCount / dbPath / degraded.
- **Embedded store**: better-sqlite3 + FTS5 (BM25, window snippets) + sqlite-vec (384-dim kNN) + KV + WAL + versioned migrations ([sqlite-store.ts](../../packages/store/src/sqlite-store.ts)).
- **ProjectId-keyed database** at `.noir/store/<projectId>.db` ([layout.ts](../../packages/core/src/layout.ts)).
- **CLI MCP client over the daemon**: `withDaemon` / `callDaemonTool` / `probeDaemon` via Streamable HTTP ([daemon-client.ts](../../packages/cli/src/daemon-client.ts)).
- **CLI surface**: `noir status` (probe-only, honest when daemon is down), `noir doctor` (liveness / native-deps / embedder / provider), `mcp serve` ([daemon.ts](../../packages/cli/src/commands/daemon.ts)).
- **`host_status` MCP tool** plus a 17+ tool surface across workflow / context / memory / store / integrations.

## Gap / roadmap delta

- **Detached/backgrounded daemon** — `--detach` is refused today; no socket activation for spawning the daemon on demand.
- **Daemon auth token** — the transport validates localhost host+origin only; no credential on the wire.
- **Per-project `daemon.json`** — a single global record clobbers across concurrent projects.
- **Configured persistent daemon port** — `daemon.port` is parsed but never consumed; the port is ephemeral.
- **Background worker architecture** — indexing is on-demand today; no scheduled/background workers.
- **Event bus / pub-sub observability** — status tools and audit JSONL only; no push observability.
- **Broader read-only FS fallback** — the runtime fallback covers the store, not the rest of the runtime.
- **Ignore-manager default list cleanup** — vestigial entries remain (`.noir/*.sock`, `.noir/daemon.pid`, `.noir/state/`).

## Acceptance criteria

- MET — `noir status` and `noir doctor` run against a live daemon and report honest state; a down daemon fails explicitly rather than silently.
- MET — a project's store is single-writer across a serve lifecycle, and `store_status` reports accurate ok / projectId / docCount / vecCount / dbPath / degraded.
- MET — stdio and Streamable HTTP expose the same MCP tool surface, and the CLI's `callDaemonTool` round-trips through it.
- MET — a writable-open failure degrades to read-only reads instead of a crash, with writes surfacing a clear error.
- DONE-WHEN — `--detach` spawns a background daemon and later CLI invocations reconnect to it via socket/port discovery.
- DONE-WHEN — the daemon transport accepts a token and rejects unauthenticated localhost callers.
- DONE-WHEN — concurrent projects each get a correct per-project daemon record, and `daemon.port` is honored when configured.
- DONE-WHEN — scheduled background workers exist (not just on-demand indexing), with observable events.

## References

- `packages/daemon/src/http.ts`
- `packages/daemon/src/stdio.ts`
- `packages/daemon/src/lifecycle.ts`
- `packages/daemon/src/store-seam.ts`
- `packages/store/src/sqlite-store.ts`
- `packages/core/src/layout.ts`
- `packages/cli/src/commands/daemon.ts`
- `packages/cli/src/daemon-client.ts`
