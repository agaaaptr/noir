export interface SkillFrontmatter {
  name: string;
  description: string;
  references?: string[];
  [k: string]: unknown; // tolerate + ignore extra keys (user-invocable, allowed-tools, …)
}

export interface BuiltinReference {
  name: string; // <kebab>.md
  content: string;
}

export interface BuiltinSkill {
  name: string; // 'noir-brainstorm'
  dir: string; // absolute builtin/<name> dir
  skillMd: string; // raw SKILL.md
  frontmatter: SkillFrontmatter;
  references: BuiltinReference[];
}

/**
 * An `IntegrationDeclaration` (parsed `integration.json`) typed structural-only
 * so `types.ts` stays Zod-free. The canonical definition lives in
 * `integrations-schema.ts` (Zod); this interface is reassigned there to keep
 * the package's public type surface in one place.
 */
export interface IntegrationDeclaration {
  name: string;
  auth: { type: 'env-var'; tokenEnv: string; fallback: 'manual-paste' | 'none' };
  runtime: 'none' | 'gated-write-proxy' | 'mcp-stdio' | 'external-mcp';
  sdd: { intakeFrom?: 'task' | 'issue' | 'none'; writeBack: string[] };
  mcp: {
    command: string;
    transport: 'stdio' | 'http';
    args?: string[];
    url?: string;
    env?: Record<string, string>;
  } | null;
}

/**
 * An integration discovered under `integrations/<name>/`: a builtin-shaped
 * skill (`SKILL.md` + optional `references/`) PLUS a parsed `integration.json`
 * declaration. `dir` is the absolute `integrations/<name>` path. The raw JSON
 * is kept so emitters that need to re-serialize (e.g. for a host MCP manifest)
 * don't have to re-infer the shape.
 */
export interface IntegrationSkill extends BuiltinSkill {
  declaration: IntegrationDeclaration;
  declarationRaw: unknown;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface EmittedFile {
  path: string[]; // relative to the skill's own dir, e.g. ['SKILL.md'] or ['references','x.md']
  content: string;
}

export interface CompiledSkill {
  name: string;
  files: EmittedFile[];
}

/**
 * A compiled integration = its compiled skill (`SKILL.md` + references) PLUS,
 * when `runtime` widens emission, a host-MCP server entry the host adapter may
 * merge into the host's MCP config (e.g. Claude's `.mcp.json`). The shape is
 * provider-neutral — the host adapter owns the on-disk format.
 */
export interface CompiledIntegration extends CompiledSkill {
  /** Present only when `runtimeEmitsHostMcp(declaration.runtime)` AND a non-null
   *  `declaration.mcp` exists. The cli/daemon layer hands this to the host
   *  adapter's `emitMcpConfig` overload (X-T2 seam); absent ⇒ skill-only. */
  hostMcp?: {
    serverName: string;
    command: string;
    args?: string[];
    transport: 'stdio' | 'http';
    url?: string;
    env?: Record<string, string>;
  };
}

export interface EmitSummary {
  dir: string;
  emitted: string[]; // skill names written (builtins + integrations)
  references: number; // reference files written (excludes SKILL.md)
  /** Integration names emitted alongside builtins (subset of `emitted`).
   *  Additive — callers that ignore it (existing cli) still get the builtins in
   *  `emitted`. */
  integrations?: string[];
}

export type CompileTarget = 'claude';
