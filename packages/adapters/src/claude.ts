import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import type {
  EmitContext,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    // Always present: the Noir MCP server (the host's gateway to Noir's own
    // tools — `noir mcp serve --stdio` or the streamable-http endpoint).
    const noirServer =
      opts.transport === 'stdio'
        ? { command: 'noir', args: ['mcp', 'serve', '--stdio'] }
        : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' };

    // Slice X — merge an integration's host MCP server entry. Claude renders
    // this only when the integration brings its own external MCP (per the
    // adapter contract: `external-mcp`). `gated-write-proxy` (ClickUp) /
    // `mcp-stdio` / `none` produce NO entry here — ClickUp writes route
    // through Noir's own MCP tool; `mcp-stdio` registers via `noirServer`.
    // `@noir-ai/skills`' `compileIntegration` already gates on the runtime +
    // null-`mcp` checks, so by the time an emission arrives here it is a
    // legitimate external MCP entry the user opted into.
    const mcpServers: Record<string, unknown> = { noir: noirServer };
    if (integration) {
      const entry =
        integration.transport === 'http'
          ? {
              type: 'http',
              url: integration.url ?? '',
              // Nest env under `env:` (NOT spread at the entry top level) so the
              // emitted `.mcp.json` shape matches the stdio branch + Claude's
              // spec. Top-level spread would leak env keys as server fields.
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
  },
  emitContext(_ctx: EmitContext): string {
    return `${CONTEXT_BLOCK_BEGIN}\n@import ".noir/NOIR.md"\n${CONTEXT_BLOCK_END}\n`;
  },
  emitRules(_ctx: EmitContext): string {
    return `${RULES_BLOCK.begin}\n@import ".noir/rules/RULES.md"\n${RULES_BLOCK.end}\n`;
  },
  skillsDir(ctx: EmitContext): string {
    return join(ctx.root, '.claude', 'skills');
  },
};
