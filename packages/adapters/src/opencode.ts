import { join } from 'node:path';
import { emitAgentsMd } from './agents-md.js';
import type {
  EmitContext,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

/**
 * The `opencode` host adapter — OpenCode. Reads the universal `AGENTS.md`
 * (context + rules unified — no separate rules emission, no skill concept).
 *
 * The DIFFERENCE from the `{mcpServers}` family lives in MCP config: OpenCode's
 * root `opencode.json` carries an `mcp` block whose entries are `type`-tagged —
 * `{ type: 'local', command: [...] }` for stdio (note: `command` is an ARRAY,
 * not the claude `{command, args}` split) and `{ type: 'http', url }` for
 * remote. The `$schema` key pins the opencode config schema. See
 * https://opencode.ai/config.json.
 *
 *  ⚠ The exact opencode.json shape (esp. stdio `command` array vs `{command,
 *    args}`, env handling, and http entry fields) should be verified against
 *    opencode.ai docs at the review step — the documented form below is the
 *    spec's best current understanding.
 */
export const opencodeAdapter: HostAdapter = {
  id: 'opencode',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    // OpenCode's `mcp` block — entries carry an explicit `type` tag:
    //   - stdio → { type: 'local', command: [...] }   (command is an ARRAY)
    //   - http  → { type: 'http',  url: ... }
    // Noir server always present; optional integration merges alongside under
    // its `serverName`. (Does NOT use buildMcpServersJson — different shape.)
    const mcp: Record<string, unknown> = {
      noir:
        opts.transport === 'stdio'
          ? { type: 'local', command: ['noir', 'mcp', 'serve', '--stdio'] }
          : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' },
    };
    if (integration) {
      mcp[integration.serverName] =
        integration.transport === 'http'
          ? {
              type: 'http',
              url: integration.url ?? '',
              ...(integration.env ? { env: integration.env } : {}),
            }
          : {
              type: 'local',
              command: [integration.command, ...(integration.args ?? [])],
              ...(integration.env ? { env: integration.env } : {}),
            };
    }
    return JSON.stringify({ $schema: 'https://opencode.ai/config.json', mcp }, null, 2);
  },
  emitContext(ctx: EmitContext): string {
    return emitAgentsMd(ctx);
  },
  // No `emitRules` — rules live IN AGENTS.md (the @-import covers RULES.md).
  // No `skillsDir` — no skill concept.
  mcpConfigPath(ctx: EmitContext): string {
    return join(ctx.root, 'opencode.json');
  },
  agentsMdPath(ctx: EmitContext): string {
    return join(ctx.root, 'AGENTS.md');
  },
};
