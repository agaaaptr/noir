export interface SkillFrontmatter {
  name: string;
  description: string;
  references?: string[];
  /** C3 enhancement — canonical agentskills.io optional fields. `metadata` is a
   *  string→string map convention; we type the two keys the registry reads. */
  metadata?: { category?: string; version?: string };
  license?: string;
  compatibility?: string;
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
  /** C3 soft-quality warnings (lint-level): thin body, no example, first-person
   *  narration, voodoo constants, time-sensitive pins. Present only when >0. */
  warnings?: string[];
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
   *  adapter's `emitMcpConfig` overload; absent ⇒ skill-only. */
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
  /** Stale `noir-*` directories removed from `dir` after emit (cleanup).
   *  Names a previous Noir version shipped but the current build no longer
   *  does (builtin renamed/removed). Only the `noir-` managed namespace is
   *  ever pruned — user skills without the prefix are NEVER touched. Empty
   *  array when nothing was stale; undefined on callers that pre-date the
   *  field (additive — old callers still get the rest of the summary). */
  pruned?: string[];
  /** `noir-*` entries the prune step REFRAINED from removing because they
   *  look user-authored (hand-rolled noir-foo/SKILL.md without canonical Noir
   *  frontmatter). `assertNotUserOwned` guard. Names only — never user skills
   *  without the `noir-` prefix (those are always left alone). */
  preservedUserOwned?: string[];
  /** One record per emitted skill file that existed AND differed from the
   *  compiled bytes, with the resolution applied. Mirrors {@link ConflictContext}
   *  / {@link ConflictRecord} in @noir-ai/create so the CLI can lift the same
   *  structured report under `--json`. */
  conflicts?: SkillConflict[];
}

/**
 * Resolution choice for a skill-file conflict. Mirrors
 * @noir-ai/create's `ConflictResolution` literally so the CLI's
 * `buildConflictOpts().onConflict` is structurally compatible, WITHOUT the
 * skills package gaining a create dependency.
 */
export type SkillConflictResolution = 'replace' | 'preserve' | 'rename' | 'duplicate' | 'cancel';

/**
 * Context passed to {@link SkillConflictResolver}. Mirrors
 * @noir-ai/create's `ConflictContext` (relPath/existing/proposed/mode) so the
 * CLI's clack resolver handles skill conflicts with the SAME code path as
 * regenerate conflicts.
 */
export interface SkillConflictContext {
  /** Path relative to the skills target dir (e.g. `noir-brainstorm/SKILL.md`). */
  relPath: string;
  /** The skill file's current on-disk bytes. */
  existing: string;
  /** The compiled bytes Noir would write. */
  proposed: string;
  /** Always `'skill'` — the artifact class (apply-to-all is per-class). */
  mode: 'skill';
}

/**
 * One record per skill file that existed AND differed from the compiled
 * bytes. Mirrors @noir-ai/create's `ConflictRecord` (additive — old callers
 * ignore it).
 */
export interface SkillConflict {
  /** Path relative to the skills target dir. */
  path: string;
  /** Always `'skill'`. */
  mode: 'skill';
  /** LCS similarity ratio (0-1). */
  similarity?: number;
  /** sha256 hex (12 chars) of the on-disk bytes. */
  existingSha: string;
  /** sha256 hex (12 chars) of the proposed bytes. */
  proposedSha: string;
  /** Resolution applied. */
  resolution: SkillConflictResolution;
}

/**
 * The resolver callback the CLI injects (clack menu, diff preview,
 * apply-to-all). Returns a bare resolution OR a rich `{resolution, applyToAll}`
 * shape; the engine unwraps both. Structurally compatible with
 * @noir-ai/create's `ConflictResolverReturn` so the CLI passes its single
 * resolver through unchanged.
 */
export type SkillConflictResolverReturn =
  | SkillConflictResolution
  | { resolution: SkillConflictResolution; applyToAll?: boolean };

export type SkillConflictResolver = (
  ctx: SkillConflictContext,
) => Promise<SkillConflictResolverReturn> | SkillConflictResolverReturn;

/**
 * The set of host-shaped compile targets the compiler knows how to emit. Was
 * `'claude'` only through v1.1; widened in S10 to the multi-host enum (mirrors
 * `@noir-ai/adapters`' `HostId` literally — duplicated here so skills does NOT
 * add an adapters dependency; the values are an S10-locked contract). See
 * `2026-07-25-s10-multihost-design.md` (A1 + the per-adapter emission table).
 *
 *  - `claude` | `agents-md` | `gemini` | `opencode` → verbatim SKILL.md + refs
 *    (the canonical format; emitted to the host's skill-equivalent dir).
 *  - `cursor` → transform to `<name>.mdc` (Cursor rule with YAML frontmatter
 *    `{description, globs, alwaysApply:false}` + SKILL.md body; no `references/`).
 *
 * The EMIT-LOCATION (where compiled files land per host — `.claude/skills/`,
 * `.cursor/rules/`, etc.) is the cli/adapter's job, NOT the compiler's; the
 * compiler just produces host-shaped CONTENT.
 */
export type CompileTarget = 'claude' | 'agents-md' | 'gemini' | 'cursor' | 'opencode';
