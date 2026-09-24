import type { IntegrationMcpEmission, McpConfigOptions } from './types.js';

/**
 * The arguments that start Noir's MCP server over stdio. A repo that has joined
 * a workspace names it here, so the host spawns the bridge, which resolves the
 * workspace daemon and reads its token itself — the entry never has to carry an
 * address or a secret. Shared by every host adapter (OpenCode carries the same
 * argv in a single `command` array) and by the scaffold upgrade that rewrites a
 * stale entry, so the invocation is spelled in exactly one place.
 */
export function noirStdioArgs(workspace?: string): string[] {
  return workspace === undefined
    ? ['mcp', 'serve', '--stdio']
    : ['mcp', 'serve', '--stdio', '--workspace', workspace];
}

/**
 * Build the host MCP config JSON string — the `{mcpServers: {...}}` shape shared
 * by claude (`.mcp.json`), agents-md (`.mcp.json`), gemini (`.gemini/mcp.json`),
 * and cursor (`.cursor/mcp.json`). OpenCode uses a DIFFERENT shape (an `mcp`
 * block with `type`-tagged entries) and does NOT use this helper — see
 * `opencode.ts`.
 *
 * The Noir server entry is always present; an optional integration entry merges
 * alongside it (per the adapter contract — only `external-mcp`
 * integrations surface a `hostMcp` block by the time it reaches here).
 *
 * Refactored out of `claude.ts` so every `{mcpServers}`-shape
 * host emits byte-identical JSON. Claude's `emitMcpConfig` now delegates here
 * (the claude.test.ts + create/scaffold.test.ts parity gates must hold).
 *
 * Stdio entry: `{ command, args }`.
 * HTTP entry : `{ type: 'http', url, [env] }` — env nested under `env:`, never
 * spread at the entry top level (would corrupt the server-field shape).
 */
export function buildMcpServersJson(
  opts: McpConfigOptions,
  integration?: IntegrationMcpEmission,
): string {
  // Always present: the Noir MCP server — `noir mcp serve --stdio` or the
  // streamable-http endpoint. The placeholder URL (`:0`) is a best-effort hint
  // the user edits; same behavior as the original claude implementation.
  // For stdio, `command` defaults to 'noir' but the engine passes the absolute
  // native-shim path when a native install is detected — GUI MCP clients (VS
  // Code, Cursor) launch from the Dock/Finder and don't read shell profiles, so
  // a bare 'noir' fails with `spawn noir ENOENT` even when ~/.noir/bin is on
  // the user's shell PATH. See resolveNoirCommand() in @noir-ai/core.
  const noirServer =
    opts.transport === 'stdio'
      ? { command: opts.command ?? 'noir', args: noirStdioArgs(opts.workspace) }
      : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' };

  const mcpServers: Record<string, unknown> = { noir: noirServer };
  if (integration) {
    const entry =
      integration.transport === 'http'
        ? {
            type: 'http',
            url: integration.url ?? '',
            // Nest env under `env:` (NOT spread at the entry top level) so the
            // emitted shape matches the stdio branch + Claude's spec. Top-level
            // spread would leak env keys as server fields.
            ...(integration.env ? { env: integration.env } : {}),
          }
        : {
            command: integration.command,
            ...(integration.args ? { args: integration.args } : {}),
            ...(integration.env ? { env: integration.env } : {}),
          };
    mcpServers[integration.serverName] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}
