import { join } from 'node:path';
import { emitAgentsMd } from './agents-md.js';
import { buildMcpServersJson } from './mcp.js';
import type {
  EmitContext,
  HostAdapter,
  IntegrationMcpEmission,
  McpConfigOptions,
} from './types.js';

/**
 * The `cursor` host adapter — Cursor. Cursor reads the universal `AGENTS.md`
 * for context (same content as every other host); that file's
 * `@.noir/rules/RULES.md` import IS the Noir working-rules surface for cursor
 * (NO separate `.cursor/rules/noir-contract.mdc` host-rules pointer — that
 * file was REMOVED: it was `noir-`-prefixed and the cursor flat-skill prune
 * in `emitSkillsToDir` deleted it on every `noir init/create/sync --host
 * cursor`). Skills compile to FLAT `.mdc` in `.cursor/rules/` via
 * `compileSkill(_, 'cursor')` (one file per skill, no per-name subdir). MCP
 * config lands at `.cursor/mcp.json`.
 *
 * `emitContext` returns the universal AGENTS.md content (the single native
 * context surface for cursor). There is NO `emitRules` here — cursor's rules
 * are delivered via AGENTS.md's `@.noir/rules/RULES.md` import, identical to
 * agents-md/opencode.
 */
export const cursorAdapter: HostAdapter = {
  id: 'cursor',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    return buildMcpServersJson(opts, integration);
  },
  emitContext(ctx: EmitContext): string {
    // Cursor reads AGENTS.md — same universal content as every other host.
    return emitAgentsMd(ctx);
  },
  skillsDir(ctx: EmitContext): string {
    // Skills compile to `.mdc` here (via `compileSkill(_, 'cursor')` in skills).
    return join(ctx.root, '.cursor', 'rules');
  },
  mcpConfigPath(ctx: EmitContext): string {
    return join(ctx.root, '.cursor', 'mcp.json');
  },
  agentsMdPath(ctx: EmitContext): string {
    return join(ctx.root, 'AGENTS.md');
  },
};
