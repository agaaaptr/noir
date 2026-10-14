import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import { buildMcpServersJson } from './mcp.js';
import type {
  EmitContext,
  EmitHooksContext,
  HookEmission,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

export const claudeAdapter: HostAdapter = {
  id: 'claude',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    // Delegates to the shared `{mcpServers}` builder. Behavior-identical to the
    // previous inline implementation — the claude.test.ts + create/scaffold.test.ts
    // byte-equality parity gates must hold (integration entry merge preserved).
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
  emitHooks(ctx: EmitHooksContext): HookEmission[] {
    // ` hook` (leading space) is the dedup marker: an existing entry whose
    // command ends in the `hook` subcommand is already wired and must not be
    // re-added on a re-emit. All four events share one command; the dispatcher
    // reads the event name from stdin and emits the right behavior per event.
    // No `onFailure:"block"` here: fail-closed needs Claude Code v2.1.295+ and
    // must be probed at runtime, so the scaffold keeps the default fail-open.
    const command = `"${ctx.command}" hook`;
    const hooks = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command }] }],
        SubagentStart: [{ hooks: [{ type: 'command', command }] }],
        PreToolUse: [{ hooks: [{ type: 'command', command }] }],
        Stop: [{ hooks: [{ type: 'command', command }] }],
      },
    };
    return [
      {
        path: '.claude/settings.local.json',
        mode: 'mergeJson',
        content: hooks,
        dedupSubstring: ' hook',
        description:
          'SessionStart + SubagentStart + PreToolUse + Stop hook entry (user-owned, written once)',
      },
    ];
  },
};
