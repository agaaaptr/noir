import type { IntegrationMcpEmission, McpConfigOptions } from './types.js';

/**
 * Build the host MCP config JSON string — the `{mcpServers: {...}}` shape shared
 * by claude (`.mcp.json`), agents-md (`.mcp.json`), gemini (`.gemini/mcp.json`),
 * and cursor (`.cursor/mcp.json`). OpenCode uses a DIFFERENT shape (an `mcp`
 * block with `type`-tagged entries) and does NOT use this helper — see
 * `opencode.ts`.
 *
 * The Noir server entry is always present; an optional integration entry merges
 * alongside it (per the Slice X adapter contract — only `external-mcp`
 * integrations surface a `hostMcp` block by the time it reaches here).
 *
 * Refactored out of `claude.ts` in S10-Adapters so every `{mcpServers}`-shape
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
  const noirServer =
    opts.transport === 'stdio'
      ? { command: 'noir', args: ['mcp', 'serve', '--stdio'] }
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
