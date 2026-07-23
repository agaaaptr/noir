import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END } from '@noir-ai/core';
import type { EmitContext, HostAdapter, McpConfigOptions } from './types.js';

// Re-export so existing callers (and tests) that import the markers from this
// module continue to resolve. The canonical home is @noir-ai/core/markers.
export { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END };

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
};
