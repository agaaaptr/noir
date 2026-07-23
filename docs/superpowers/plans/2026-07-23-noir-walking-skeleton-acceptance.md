# Noir Walking Skeleton — Manual Acceptance

## Gate 1 (stdio round-trip) — thesis proof
1. `pnpm build`
2. In a scratch project dir: `node packages/cli/dist/bin.js init`
3. Confirm `.noir/` (NOIR.md, config.yml, project.id) and root `.mcp.json` + `CLAUDE.md` exist.
4. Open that dir in Claude Code (the `.mcp.json` points Claude at `noir mcp serve --stdio`).
5. Invoke the `noir` MCP tool -> `host_status`. **Expected:** JSON with `transport: "stdio"`, `daemon: false`, `host: "claude"`, and a non-empty `project.id`.

> If `noir` is not on PATH, either `pnpm link --global` the cli, or edit `.mcp.json` to `{"mcpServers":{"noir":{"command":"node","args":["<repo>/packages/cli/dist/bin.js","mcp","serve","--stdio"]}}}`.

## Gate 2 (daemon-backed) — shared state + degradation
1. `node packages/cli/dist/bin.js daemon start` -> prints a `http://127.0.0.1:<port>/mcp` URL.
2. `curl http://127.0.0.1:<port>/health` -> `{"ok":true,"pid":...,"uptimeSec":...}`.
3. (Optional) `node packages/cli/dist/bin.js init --transport streamable-http --url http://127.0.0.1:<port>/mcp`, then in Claude Code invoke `host_status`. **Expected:** `transport: "streamable-http"`, `daemon: true`, `pid` present.
4. Start a second Claude Code session against the same daemon; both report the same `pid` (shared daemon).
5. `node packages/cli/dist/bin.js daemon stop`; then `node packages/cli/dist/bin.js mcp serve --stdio` still answers `host_status` with `transport: "stdio"` (FS fallback).
