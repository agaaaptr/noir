export interface EmitContext {
  root: string;
}

export interface McpConfigOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

/**
 * Provider-neutral host MCP server entry an integration can ask the adapter to
 * merge into the host's MCP config (e.g. Claude's `.mcp.json`). Surfaced by
 * `@noir-ai/skills`' `compileIntegration().hostMcp` ONLY when the integration's
 * `runtime ∈ {mcp-stdio, external-mcp}` AND it carries a non-null `mcp`
 * declaration. Defined here (not imported from skills) so adapters does NOT
 * add a skills dependency — the structural shape travels cleanly across the
 * package boundary.
 */
export interface IntegrationMcpEmission {
  serverName: string;
  command: string;
  args?: string[];
  transport: 'stdio' | 'http';
  url?: string;
  env?: Record<string, string>;
}

export interface HostAdapter {
  readonly id: string;
  /** Full contents of the host's MCP config file (e.g. .mcp.json).
   *
   *  Two-arg form (the original, used by `noir init`/`sync` today): emits only
   *  the host's Noir MCP server entry. Backward-compatible — existing callers
   *  keep working unchanged.
   *
   *  Three-arg form (Slice X S10-aware overload): when an integration widens
   *  emission (`runtime:'external-mcp'` for Claude), merge the integration's
   *  server entry alongside the Noir entry. For `gated-write-proxy`/
   *  `mcp-stdio`/`none` Claude renders no NEW entry — `mcp-stdio` registers
   *  through the existing `noir mcp serve --stdio` entry, and ClickUp writes
   *  route through Noir's own MCP tool (no host MCP wiring). */
  emitMcpConfig(
    ctx: EmitContext,
    opts: McpConfigOptions,
    integration?: IntegrationMcpEmission,
  ): string;
  /** Managed block to insert into the host's context file (e.g. CLAUDE.md). */
  emitContext(ctx: EmitContext): string;
  /** Managed block inserting the host's AI-rules import (e.g. @.noir/rules/RULES.md). */
  emitRules?(ctx: EmitContext): string;
  /** Host's skill directory (e.g. .claude/skills). Absent ⇒ host has no skill concept. */
  skillsDir?(ctx: EmitContext): string;
  install?(ctx: EmitContext): Promise<void>;
  healthCheck?(ctx: EmitContext): Promise<boolean>;
}
