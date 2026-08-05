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
 * not the claude `{command, args}` split) and `{ type: 'remote', url }` for
 * remote (HTTP/SSE). Server env vars land under the `environment` key (NOT
 * `env`). The `$schema` key pins the opencode config schema. See
 * https://opencode.ai/docs/mcp-servers/ + https://opencode.ai/config.json.
 *
 * Verified verbatim from the opencode docs ("Add remote MCP servers by setting
 * `type` to `\"remote\"`"); the prior `type:'http'` / `env:` shape was wrong.
 */
export const opencodeAdapter: HostAdapter = {
  id: 'opencode',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    // OpenCode's `mcp` block — entries carry an explicit `type` tag (verified
    // against https://opencode.ai/docs/mcp-servers/):
    //   - stdio  → { type: 'local',  command: [...] }   (command is an ARRAY)
    //   - remote → { type: 'remote', url: ... }          (HTTP/SSE — NOT 'http')
    // Server env vars land under `environment:` (NOT `env:` — opencode's own
    // spelling). Noir server always present; optional integration merges
    // alongside under its `serverName`. (Does NOT use buildMcpServersJson —
    // different shape; that helper's `env:` is correct for `.mcp.json` /
    // `.cursor/mcp.json` / `.gemini/mcp.json`.)
    const mcp: Record<string, unknown> = {
      noir:
        opts.transport === 'stdio'
          ? // Thread opts.command like buildMcpServersJson does (mcp.ts:36) — the
            // absolute native shim when resolveNoirCommand() detects a native
            // install, so GUI MCP clients (no shell profile PATH) can spawn it.
            { type: 'local', command: [opts.command ?? 'noir', 'mcp', 'serve', '--stdio'] }
          : { type: 'remote', url: opts.url ?? 'http://127.0.0.1:0/mcp' },
    };
    if (integration) {
      mcp[integration.serverName] =
        integration.transport === 'http'
          ? {
              type: 'remote',
              url: integration.url ?? '',
              ...(integration.env ? { environment: integration.env } : {}),
            }
          : {
              type: 'local',
              command: [integration.command, ...(integration.args ?? [])],
              ...(integration.env ? { environment: integration.env } : {}),
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
