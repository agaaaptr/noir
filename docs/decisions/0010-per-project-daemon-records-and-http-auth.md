# ADR-0010 — Per-project daemon records, a real `daemon.port`, and HTTP-only auth

- **Status:** Accepted
- **Date:** 2026-09-11
- **Spec:** `docs/internal/specs/2026-09-11-daemon-hardening-init-completeness-design.md`

## Context

Three defects in the daemon's identity and transport had accumulated behind three
separate compensating guards:

1. **One global record.** `~/.noir/daemon.json` described whichever daemon started
   last. Running Noir in two projects clobbered it, and `ensureDaemonRunning` /
   `daemon stop` / `status` each carried their own `wrongProject` check to avoid
   adopting a foreign daemon — a bug fixed by guard in three places instead of
   structurally.
2. **A dead knob.** `daemon.port` was parsed and validated by the config schema
   and consumed nowhere; the daemon always bound an ephemeral port.
3. **An unauthenticated transport.** The Streamable HTTP transport validated
   localhost host + origin only. Any same-machine caller that could reach loopback
   could drive the full MCP tool surface.

`workspace-record.ts` already solved (1) for workspaces: one file per identity, so
no code path can read, adopt, or clear another identity's record. This slice
applies the same reasoning to projects, and settles the decisions that fall out
of it.

## Decision

**Records are per-project.** `packages/daemon/src/project-record.ts` owns
`~/.noir/daemons/<projectId>.json` (`{pid, port, startedAt, mode?, projectId}`),
with `readProjectDaemonRecord` / `writeProjectDaemonRecord` /
`clearProjectDaemonRecord` / `listProjectDaemonRecords`. The `wrongProject`
guards in `ensure.ts` / `commands/daemon.ts` are **deleted**: foreign-record
access is now impossible by construction rather than policed by a check.
`NOIR_DAEMON_DIR` overrides the directory for test isolation — and is refused
from `.noir/.env`, since redirecting it is a hijack vector (see ADR-0011).

**The legacy record is read exactly once, by a self-deleting migration.**
`retireLegacyDaemonRecord()` (`migrate-legacy-record.ts`) runs from
`ensureDaemonRunning` on the first daemon-touching command: it SIGTERMs the
recorded pid (bounded wait, boot-boundary-aware so a post-reboot pid collision
can never signal an unrelated process), then deletes `~/.noir/daemon.json`. A
permanent compatibility path was rejected (it keeps two writers alive forever);
a pure "delete and document" was rejected because it leaves a two-writer window
on the store, bounded at `idleTimeoutSec` but real. A record whose bytes were
read but do not parse is deleted — an unreadable one is not, and refuses the
command instead.

**`daemon.port` is a preference, not a demand.** When configured it is threaded
to the HTTP listener; on `EADDRINUSE` the daemon retries ephemeral and warns on
stderr rather than failing the command, because two projects may legitimately
configure the same port. The record always names the port actually bound, so the
record never lies.

**Auth covers the HTTP transport only.** stdio has no network surface; the
anchor host has open header-forwarding bugs, so a header-delivered token is not
safe there; and a token in `.mcp.json` is a secret in a committable file. The
daemon mints a **fresh 32-byte token per start**, writes it at mode `0600` to
`~/.noir/daemons/<scopeKey>.token` next to that identity's record (written
*before* the record, so a client that can see the record can already read the
secret — no 401 window on a fresh start), and enforces it on `/mcp` with a
constant-time compare. `/health` stays token-free. Clients read the file; the
token is never a config value. A workspace daemon gets the same treatment keyed
by workspace name, and because a workspace's clients are frequently host-managed,
the documented wiring is `headersHelper` — a *command* stored in config rather
than the secret itself.

**Activation is client-side and cross-platform.** `withDaemon` becomes
connect-first on the project path: connect to the recorded port, and only on
`ECONNREFUSED` spawn and reconnect with bounded backoff. systemd socket units and
launchd plists were rejected — Linux/macOS-only, a service-management surface
Noir does not have, and nothing for Windows. The workspace path is **exempt**:
`withWorkspaceDaemon` stays probe-only, per ADR-0009 §11, and an implementation
that routed workspace calls through auto-activation would violate that ADR.

**Runtime directories are documented, not created eagerly.** `~/.noir/daemons/`
and friends are gitignored, so a `.gitkeep` would be ignored too; `.noir/README.md`
explains the map instead.

## Consequences

- Two projects on one machine each run a daemon; both records coexist under
  `~/.noir/daemons/` and neither is cleared by the other's activity. Three guard
  code paths disappear.
- **Breaking on-disk change.** A daemon started by a pre-1.14 version is retired
  on the first daemon-touching command; a host `.mcp.json` written for a
  workspace (`type: 'http'`) must be re-established after upgrade because the
  port and token change (`noir workspace leave` / `join` rewrites it).
- The token defends against another **local user** reaching the tool surface over
  loopback. It does **not** defend against a same-uid process, which can read the
  0600 file — inherent to any loopback scheme. Host/origin validation stays and
  continues to block the browser vector.
- A workspace named identically to a projectId would collide in the shared
  `daemons/` namespace. Accepted as a documented limitation: project ids are
  UUIDs and workspace names are deliberate user choices.
- Connect-first does not remove first-command latency; it makes a spawn follow a
  *genuinely attempted* connection instead of a command that may not need one.
  Without a configured `daemon.port` there is no stable address to probe, so that
  case keeps the ensure-first path.

## See also

- **ADR-0009 — Shared cross-repo workspaces** (§11: the workspace path is
  probe-only; this slice does not reopen it).
- **ADR-0011 — `.noir/.env` precedence and doctrine** (the `NOIR_DAEMON_DIR`
  refusal).
- `docs/reference/environment.md` (`NOIR_DAEMON_DIR`, `NOIR_DAEMON_JSON`
  legacy-only), `docs/how-to/shared-workspaces.md` (workspace token +
  `headersHelper`).
