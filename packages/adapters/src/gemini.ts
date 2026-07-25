import { join } from 'node:path';
import { CONTEXT_BLOCK_BEGIN, CONTEXT_BLOCK_END, RULES_BLOCK } from '@noir-ai/core';
import { buildMcpServersJson } from './mcp.js';
import type {
  EmitContext,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

/**
 * The `gemini` host adapter — Gemini CLI. Emits `GEMINI.md` (Gemini's native
 * context file) carrying BOTH the context block AND the rules block — Gemini
 * has no separate rules file. Uses Gemini's `@file` import syntax: bare
 * `@.noir/NOIR.md` (no `@import` keyword, no quotes — distinct from Claude's
 * `@import ".noir/..."` form). The cli ALSO emits a root `AGENTS.md` via the
 * shared `emitAgentsMd` helper (Gemini reads AGENTS.md too).
 *
 * Managed-block form (CONTEXT_BLOCK + RULES_BLOCK markers) is used so user
 * content outside the markers survives `noir sync` rewrites — consistent with
 * the claude adapter's contract.
 *
 * MCP config lands at `.gemini/mcp.json` (workspace-level — the portable
 * choice; `~/.gemini/settings.json` is the global alternative, documented).
 */
export const geminiAdapter: HostAdapter = {
  id: 'gemini',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    return buildMcpServersJson(opts, integration);
  },
  emitContext(_ctx: EmitContext): string {
    // Gemini's `@file` import: bare `@.noir/...` (no `@import`, no quotes).
    // Rules folded into the same GEMINI.md (per spec — Gemini has no separate
    // rules file). Both blocks are marker-wrapped so user content survives sync.
    return (
      `${CONTEXT_BLOCK_BEGIN}\n@.noir/NOIR.md\n${CONTEXT_BLOCK_END}\n` +
      `${RULES_BLOCK.begin}\n@.noir/rules/RULES.md\n${RULES_BLOCK.end}\n`
    );
  },
  // No `emitRules` — rules folded into emitContext (GEMINI.md carries both).
  // No `skillsDir` — no skill concept; GEMINI.md + AGENTS.md are the surface.
  mcpConfigPath(ctx: EmitContext): string {
    return join(ctx.root, '.gemini', 'mcp.json');
  },
  agentsMdPath(ctx: EmitContext): string {
    return join(ctx.root, 'AGENTS.md');
  },
};
