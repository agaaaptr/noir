import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
import type { EmitContext, HostAdapter, McpConfigOptions } from './types.js';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  emitMcpConfig(_ctx, opts: McpConfigOptions): string {
    const server =
      opts.transport === 'stdio'
        ? { command: 'noir', args: ['mcp', 'serve', '--stdio'] }
        : { type: 'http', url: opts.url ?? 'http://127.0.0.1:0/mcp' };
    return JSON.stringify({ mcpServers: { noir: server } }, null, 2);
  },
  emitContext(_ctx: EmitContext): string {
    return `${CONTEXT_BLOCK_BEGIN}\n@import ".noir/NOIR.md"\n${CONTEXT_BLOCK_END}\n`;
  },
  skillsDir(ctx: EmitContext): string {
    return join(ctx.root, '.claude', 'skills');
  },
};
