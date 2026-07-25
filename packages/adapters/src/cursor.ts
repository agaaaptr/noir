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
 * for context (same content as every other host); the Noir working rules land
 * as a Cursor `.mdc` rule file the cli writes to `.cursor/rules/noir-rules.mdc`.
 * Skills compile to `.mdc` in `.cursor/rules/` via `compileSkill(_, 'cursor')`
 * (the skills compiler owns the per-skill transform; the cli owns writing them
 * to `skillsDir`). MCP config lands at `.cursor/mcp.json`.
 *
 * `emitRules` returns the `.mdc` CONTENT for the Noir rules file — frontmatter
 * (`description` / `globs` / `alwaysApply: false`) + a pointer to the canonical
 * `.noir/rules/RULES.md`. Cursor's `.mdc` format does not reliably resolve
 * `@`-imports, so we POINT to the rules (the cli may choose to inline in a
 * later pass — the contract here is content shape, not inlining policy).
 * `alwaysApply: false` is the spec's locked default — the agent decides whether
 * to pull the rule via the `description`.
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
  emitRules(_ctx: EmitContext): string {
    // The noir-rules .mdc — frontmatter with a wildcard `globs` entry +
    // `alwaysApply: false` (the agent decides via `description`). Body POINTS
    // to the canonical RULES.md. Hand-rolled YAML (fixed strings, no special
    // chars) — avoids adding a `yaml` dep to adapters for one stable shape.
    return (
      '---\n' +
      'description: Noir working rules\n' +
      'globs:\n' +
      "  - '**/*'\n" +
      'alwaysApply: false\n' +
      '---\n' +
      '# Noir working rules\n\n' +
      'See `.noir/rules/RULES.md` for the canonical Noir working rules.\n'
    );
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
