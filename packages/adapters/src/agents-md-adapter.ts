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
 * The `agents-md` host adapter — the 32-platform universal AGENTS.md standard.
 * The SMALLEST surface: a root `AGENTS.md` (context + rules unified — the
 * `@.noir/` imports already cover both NOIR.md and RULES.md), no skill concept
 * (the context IS the surface), and a workspace `.mcp.json` (the Claude shape —
 * broadly compatible; many AGENTS.md readers also read it).
 *
 * This adapter is the fallback / universal baseline — any host that "just reads
 * AGENTS.md" (incl. qwen/agy and other deferred hosts) behaves identically to
 * this. Per-host specialization lives in the other adapters' native files.
 */
export const agentsMdAdapter: HostAdapter = {
  id: 'agents-md',
  emitMcpConfig(_ctx, opts: McpConfigOptions, integration?: IntegrationMcpEmission): string {
    return buildMcpServersJson(opts, integration);
  },
  emitContext(ctx: EmitContext): string {
    // The universal AGENTS.md content — byte-identical across every adapter
    // that composes `emitAgentsMd` (agents-md / gemini / cursor / opencode).
    return emitAgentsMd(ctx);
  },
  // No `emitRules` — rules live IN the AGENTS.md content already (the
  // `@.noir/rules/RULES.md` import covers them).
  // No `skillsDir` — no skill concept for the universal host.
  mcpConfigPath(ctx: EmitContext): string {
    return join(ctx.root, '.mcp.json');
  },
  agentsMdPath(ctx: EmitContext): string {
    return join(ctx.root, 'AGENTS.md');
  },
};
