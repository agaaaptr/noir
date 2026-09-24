# ADR-0013 — Workspace transport via the stdio bridge, and 400 for a misdirected workspace URL

- **Status:** Accepted
- **Date:** 2026-09-24
- **Spec:** `docs/internal/specs/2026-09-24-display-transport-permission-hygiene-design.md`

## Context

A shared workspace (ADR-0009) is served by a **workspace daemon** that a member repo's host
reaches through the `noir` MCP entry in `.mcp.json`. In 1.15.0 that entry carried a listening
URL — `http://127.0.0.1:<port>/mcp?p=<projectId>` — plus, per ADR-0010, a bearer-token
requirement. Two defects made that arrangement unreachable by construction:

1. **The URL goes stale by construction.** The workspace daemon binds an ephemeral port and
   mints a fresh token on every start, but the URL is written once at join time. The port and
   token both change on the next start, so the committed URL points nowhere.
2. **There is no credential path.** `.mcp.json` entries written by `join` / `start --workspace`
   carried no auth material, and `noir daemon token` resolves the *caller's* project identity,
   so a host-managed connection had no supported way to obtain the workspace token.

A separate, independent defect sits on the **project** daemon: it matches `req.url === '/mcp'`
exactly and answers a query-string URL — the workspace shape, `/mcp?p=…` — with a bare
`404 not found`, a status that says "path does not exist" when the real problem is that the
caller addressed the wrong daemon.

Both fixes are implemented on `develop` and unreleased at the time of writing.

## Decision

**The host reaches a workspace through the stdio bridge, not a URL.** A joined repo's
`.mcp.json` entry names the workspace and points at the stdio entry
(`noir mcp serve --stdio --workspace <name>`). The bridge resolves the workspace daemon,
verifies it owns the record through `/health`, reads the `0600` token, and relays every
message both ways to `/mcp?p=<caller projectId>`. The config file carries no secret and no
URL that can go stale, and the host's undocumented header-forwarding behaviour — the reason
ADR-0010 kept a token out of `.mcp.json` `headers` — is removed from the path entirely.

**A project daemon answers `400` for a misdirected workspace URL.** When a project daemon
receives a query-string MCP URL it returns `400` with a body naming the flavour mismatch —
the caller has addressed a workspace-shaped URL at a project daemon, which serves one project
at a bare `/mcp`. `404` stays reserved for genuinely unknown paths.

## Alternatives considered

- **A stable bearer token in the `.mcp.json` `headers`** — rejected: a long-lived secret
  lands in a committed file, and every workspace member must receive and protect it.
- **Token-free loopback** — rejected: it drops the auth boundary against other local
  processes that ADR-0010 deliberately added.
- **`404` with an explanatory body for the misdirected URL** — rejected: the status misleads;
  "path does not exist" is false, and a caller has no reason to read the body of a 404.
- **Silently accepting the query on a project daemon** — rejected: it hides the wrong-target
  mistake and routes traffic where it was never meant to go.

## Consequences

- A joined repo works without a stable port or a shared secret; the removed failure classes
  are the stale URL, the missing credential path, and the host's header-forwarding bugs.
- The bridge is the single place that reads the token, narrowing the `0600` file's read
  surface to the process that already owns the daemon relationship.
- The `400` turns a confusing "404 / not authenticated" pair into an actionable
  "you addressed the wrong daemon" signal; genuine 404s still mean "no such path".
- Both decisions change a documented interface, so they ship with a rewritten
  `docs/how-to/shared-workspaces.md` and a CHANGELOG entry in the same checkpoint.

Each decision is reversible independently: a URL-based entry would be justified again only if
a future transport needed a stable, secret-bearing URL in a committed config — which
reintroduces the stale-URL and secret-in-config classes this removes. Reverting `400` to
`404` would be justified only if a caller came to depend on the exact status code; nothing
does, because the body already makes the signal explicit.

## See also

- **ADR-0009 — Shared cross-repo workspaces** (introduces the workspace daemon and the `?p=`
  routing the bridge now reaches over stdio).
- **ADR-0010 — Per-project daemon records, a real `daemon.port`, and HTTP-only auth**
  (mints the `0600` token the bridge reads, and explains why a token never belongs in
  `.mcp.json`).
