import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import { buildMcpServersJson } from './mcp.js';
import type {
  EmitContext,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    // Delegates to the shared `{mcpServers}` builder. Behavior-identical to the
    // pre-S10 inline implementation — the claude.test.ts + create/scaffold.test.ts
    // byte-equality parity gates must hold (Slice X integration merge preserved).
    return buildMcpServersJson(opts, integration);
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
