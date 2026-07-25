export interface EmitContext {
  root: string;
}

export interface McpConfigOptions {
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

export interface HostAdapter {
  readonly id: string;
  /** Full contents of the host's MCP config file (e.g. .mcp.json). */
  emitMcpConfig(ctx: EmitContext, opts: McpConfigOptions): string;
  /** Managed block to insert into the host's context file (e.g. CLAUDE.md). */
  emitContext(ctx: EmitContext): string;
  /** Managed block inserting the host's AI-rules import (e.g. @.noir/rules/RULES.md). */
  emitRules?(ctx: EmitContext): string;
  /** Host's skill directory (e.g. .claude/skills). Absent ⇒ host has no skill concept. */
  skillsDir?(ctx: EmitContext): string;
  install?(ctx: EmitContext): Promise<void>;
  healthCheck?(ctx: EmitContext): Promise<boolean>;
}
