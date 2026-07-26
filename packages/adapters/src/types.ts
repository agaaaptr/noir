/**
 * The set of host CLIs Noir knows how to scaffold for. The `host:` config
 * (in @noir-ai/core) + `CompileTarget` (in @noir-ai/skills) widen to this
 * same enum. Defined HERE (in adapters) rather than core/skills so the host
 * list has ONE owner; core/skills carry the enum string literals only (no
 * cross-package dep). See `2026-07-25-s10-multihost-design.md` (A1).
 *
 *  - `claude`     — Claude Code (the v1 default; the regression anchor).
 *  - `agents-md`  — the 32-platform universal AGENTS.md standard.
 *  - `gemini`     — Gemini CLI (GEMINI.md + AGENTS.md).
 *  - `cursor`     — Cursor (.cursor/rules/*.mdc + AGENTS.md).
 *  - `opencode`   — OpenCode (AGENTS.md + opencode.json).
 *
 * Add a new host here, extend `resolveAdapter`'s registry, and the schema +
 * compiler widen automatically.
 */
export type HostId = 'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode';

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

/**
 * The host-facing subset of a Noir handoff artifact. Defined HERE so the
 * optional {@link HostAdapter.emitHandoff} hook has a typed payload without the
 * adapters package taking a CLI dependency — the CLI conforms its richer
 * snapshot to this shape before handing it to the adapter. Every field is
 * nullable so a daemon-down / no-active-task handoff still type-checks.
 */
export interface HandoffPayload {
  project: { id: string; name: string };
  host: HostId;
  /** Active workflow task, if any. Null when no task is active or daemon-down. */
  task: {
    taskId: string;
    phase: string;
    nextGate: string | null;
    nextSkill: string | null;
  } | null;
}

export interface HostAdapter {
  /** The host identifier — must match a `HostId` registry key. Tightened from
   *  `string` to `HostId` in S10 so the registry is type-safe end-to-end. */
  readonly id: HostId;
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
  /** S10 seam — where the host's MCP config file lives (workspace-level), e.g.
   *  `.mcp.json`, `.cursor/mcp.json`, `.gemini/mcp.json`, `opencode.json`. The
   *  cli uses this to write the string returned by `emitMcpConfig` to disk.
   *  Absent ⇒ the cli falls back to a host-specific default (or skips for
   *  hosts with no MCP concept). Optional so existing adapters keep working
   *  unchanged; new adapters implement it. */
  mcpConfigPath?(ctx: EmitContext): string;
  /** S10 seam — where the universal AGENTS.md goes. Defaults to root `AGENTS.md`
   *  for every host (the 32-platform standard); overridable for hosts that want
   *  it elsewhere. The shared `emitAgentsMd(ctx)` helper produces the CONTENT
   *  (byte-identical across hosts); the cli writes it to this path. */
  agentsMdPath?(ctx: EmitContext): string;
  /** Host-handoff seam — the host-specific directive block for a Noir handoff
   *  artifact (the "Open \`<host>\` …" portion). OPTIONAL so existing / third-party
   *  adapters continue to type-check without implementing it; the CLI falls back
   *  to {@link hostLaunchDirective} (the generic single-line directive) when this
   *  is absent. A host that wants richer handoff wording (e.g. naming its native
   *  context file or skill dir) implements this. TEXT ONLY — never launches the
   *  host (doctrine: Noir never spawns the host; the directive is pasteable text). */
  emitHandoff?(ctx: EmitContext, payload: HandoffPayload): string;
}
