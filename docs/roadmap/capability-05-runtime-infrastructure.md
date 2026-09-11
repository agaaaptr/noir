# Capability 5 — Runtime Infrastructure & Local Daemon

> **Status:** Shipped — daemon + store + transports are live, including per-project records, a configured port, and HTTP auth; socket activation / workers / event bus are research

## Overview

The local runtime behind the Noir CLI: an `@noir-ai/daemon` MCP server with a single-writer embedded store and stdio + Streamable HTTP transports, backed by an `@noir-ai/store` built on SQLite/FTS5/sqlite-vec. The daemon owns the project database and exposes the full MCP tool surface; the CLI talks to it over Streamable HTTP, and a read-only fallback keeps reads working when the store cannot be opened for writes.

## Shipped today

- **Foreground HTTP daemon** on 127.0.0.1: `GET /health` plus the `/mcp` Streamable HTTP route; idle-timeout shutdown and SIGINT/SIGTERM cleanup ([http.ts](../../packages/daemon/src/http.ts), [lifecycle.ts](../../packages/daemon/src/lifecycle.ts)).
- **Per-project daemon records**: one record per identity at `~/.noir/daemons/<projectId>.json` (`{pid, port, startedAt, mode?, projectId}`), so two projects on one machine never clobber each other; `NOIR_DAEMON_DIR` overrides the directory for isolation. The `wrongProject` guards this replaces are deleted — foreign-record access is impossible by construction ([project-record.ts](../../packages/daemon/src/project-record.ts), ADR-0010).
- **One-shot legacy migration**: the pre-1.14 global `~/.noir/daemon.json` is read exactly once — the recorded pid is SIGTERMed (bounded wait, boot-boundary-aware) and the file is deleted — then no code path reads the legacy shape again ([migrate-legacy-record.ts](../../packages/daemon/src/migrate-legacy-record.ts)).
- **`daemon.port` honoured as a preference**: when configured it is threaded to the listener; on `EADDRINUSE` the daemon degrades to an ephemeral port with a warning rather than failing, and the record always names the port actually bound ([http.ts](../../packages/daemon/src/http.ts)).
- **HTTP-transport auth token**: a fresh 32-byte token per start, written `0600` to `~/.noir/daemons/<scopeKey>.token` next to that identity's record and before it (no 401 window on a fresh start), enforced on `/mcp` with a constant-time compare; `/health` stays token-free. Clients read the 0600 file — never a config value; a workspace daemon is keyed by workspace name ([token.ts](../../packages/daemon/src/token.ts), [http.ts](../../packages/daemon/src/http.ts)).
- **Connect-first activation** on the project path: `withDaemon` connects to the recorded port first and spawns only on `ECONNREFUSED`, with bounded backoff. The workspace path stays probe-only (ADR-0009 §11) ([daemon-client.ts](../../packages/cli/src/daemon-client.ts)).
- **Single-writer discipline**: the store is opened once per serve lifecycle and the same handle is reused across requests — no per-request re-open races ([store-seam.ts](../../packages/daemon/src/store-seam.ts)).
- **Two transports, one server**: both stdio and Streamable HTTP expose the same `McpServer` ([stdio.ts](../../packages/daemon/src/stdio.ts)). stdio carries no token — it has no network surface, and a header-delivered token is unsafe there.
- **Read-only FS fallback**: on writable-open failure the store reopens `{readonly:true}`; reads keep working, writes throw honest errors.
- **`store_status` tool**: reports ok / projectId / docCount / vecCount / dbPath / degraded.
- **Embedded store**: better-sqlite3 + FTS5 (BM25, window snippets) + sqlite-vec (384-dim kNN) + KV + WAL + versioned migrations ([sqlite-store.ts](../../packages/store/src/sqlite-store.ts)).
- **ProjectId-keyed database** at `.noir/store/<projectId>.db` ([layout.ts](../../packages/core/src/layout.ts)).
- **CLI MCP client over the daemon**: `withDaemon` / `callDaemonTool` / `probeDaemon` via Streamable HTTP ([daemon-client.ts](../../packages/cli/src/daemon-client.ts)).
- **CLI surface**: `noir status` (probe-only, honest when daemon is down), `noir doctor` (liveness / native-deps / embedder / provider), `noir daemon token` (prints the bearer token for a host `headersHelper`), `mcp serve` ([daemon.ts](../../packages/cli/src/commands/daemon.ts)).
- **`host_status` MCP tool** plus a 17+ tool surface across workflow / context / memory / store / integrations.

## Gap / roadmap delta

- **Socket activation** for the daemon (spawn on demand from a service manager) — not implemented. Real `--detach` backgrounding shipped in 1.8.0 (ADR-0006) and connect-first activation means a daemon now starts because a connection was genuinely attempted, but neither is socket activation. systemd socket units / launchd plists were rejected in ADR-0010 as Linux/macOS-only, adding a service-management surface Noir does not have, and giving Windows nothing.
- **Background worker architecture** — indexing is on-demand today; no scheduled/background workers.
- **Event bus / pub-sub observability** — status tools and audit JSONL only; no push observability. (The workspace change feed ships a cursor + long-poll `await_changes` — a signal-only push equivalent, not a general event bus.)
- **Broader read-only FS fallback** — the runtime fallback covers the store, not the rest of the runtime.

## Acceptance criteria

- MET — `noir status` and `noir doctor` run against a live daemon and report honest state; a down daemon fails explicitly rather than silently.
- MET — a project's store is single-writer across a serve lifecycle, and `store_status` reports accurate ok / projectId / docCount / vecCount / dbPath / degraded.
- MET — stdio and Streamable HTTP expose the same MCP tool surface, and the CLI's `callDaemonTool` round-trips through it.
- MET — a writable-open failure degrades to read-only reads instead of a crash, with writes surfacing a clear error.
- MET — `--detach` spawns a background daemon and later CLI invocations reconnect to it from the project's own record.
- MET — the daemon transport accepts a token and rejects unauthenticated localhost callers on `/mcp` (ADR-0010).
- MET — concurrent projects each get a correct per-project daemon record, and `daemon.port` is honored when configured (falling back to ephemeral with a warning when taken).
- DONE-WHEN — scheduled background workers exist (not just on-demand indexing), with observable events.

## References

- `packages/daemon/src/http.ts`
- `packages/daemon/src/token.ts`
- `packages/daemon/src/project-record.ts`
- `packages/daemon/src/migrate-legacy-record.ts`
- `packages/daemon/src/stdio.ts`
- `packages/daemon/src/lifecycle.ts`
- `packages/daemon/src/store-seam.ts`
- `packages/store/src/sqlite-store.ts`
- `packages/core/src/layout.ts`
- `packages/cli/src/commands/daemon.ts`
- `packages/cli/src/daemon-client.ts`
