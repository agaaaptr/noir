import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { discoverAll, discoverBuiltin } from './discover.js';
import { runtimeEmitsHostMcp } from './integrations-schema.js';
import type {
  BuiltinSkill,
  CompiledIntegration,
  CompiledSkill,
  CompileTarget,
  EmitSummary,
  IntegrationSkill,
  SkillFrontmatter,
  ValidationResult,
} from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_RE = /^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const WHEN_START =
  /^(use|using|used|whenever|when|before|after|while|starting|encountering|completing|creating|about to|upon|during|to|for|on)\b/i;
const MAX_DESC = 1024;

export function parseFrontmatter(md: string): SkillFrontmatter {
  const m = md.match(FRONTMATTER_RE);
  if (!m) throw new Error('Skill missing YAML frontmatter (expected --- ... ---)');
  // Group 1 always exists when the regex matches; guard past noUncheckedIndexedAccess.
  const yaml = m[1];
  if (yaml === undefined) throw new Error('Skill missing YAML frontmatter (expected --- ... ---)');
  const fm = parseYaml(yaml) as SkillFrontmatter;
  if (typeof fm?.name !== 'string' || typeof fm?.description !== 'string') {
    throw new Error('Skill frontmatter requires string `name` + `description`');
  }
  return fm;
}

export function bodyOf(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

/** A WHEN description leads with its trigger. Requiring a leading cue — rather
 *  than a loose "contains when/before/after anywhere" — avoids false positives
 *  ("A tool that decides when to run tests") and accepts valid leads ("Upon…"). */
export function looksLikeWhenDescription(desc: string): boolean {
  return WHEN_START.test(desc.trim());
}

export function validateSkill(skill: BuiltinSkill): ValidationResult {
  const errors: string[] = [];
  const { name, description } = skill.frontmatter;
  if (!name) errors.push('missing `name`');
  else if (!NAME_RE.test(name)) errors.push(`name "${name}" must match noir-<kebab>`);
  if (basename(skill.dir) !== name) {
    errors.push(`dir "${basename(skill.dir)}" must equal name "${name}"`);
  }
  if (!description?.trim()) errors.push('missing `description`');
  else if (description.length > MAX_DESC) errors.push(`description exceeds ${MAX_DESC} chars`);
  else if (!looksLikeWhenDescription(description)) {
    errors.push('description must state WHEN to trigger (e.g. "Use when…"), not WHAT it does');
  }
  for (const r of skill.references) {
    if (!/^[a-z0-9-]+\.md$/i.test(r.name)) errors.push(`reference "${r.name}" must be <kebab>.md`);
    if (!r.content.trim()) errors.push(`reference "${r.name}" is empty`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Compile a builtin skill into the host-shaped `CompiledSkill`. The validator
 * runs for every target (a malformed skill is malformed in any format).
 *
 *  - `claude` | `agents-md` | `gemini` | `opencode` (the AGENTS.md-aligned
 *    hosts): canonical format copied verbatim — `SKILL.md` plus its
 *    `references/` siblings (DS-4). These hosts read the same SKILL.md shape;
 *    the EMIT-LOCATION (which dir they land in) is the cli/adapter's job, not
 *    the compiler's.
 *  - `cursor`: transform into a Cursor `.mdc` rule — ONE file `<name>.mdc`
 *    whose frontmatter carries the skill description, a wildcard globs entry,
 *    and `alwaysApply: false` (the agent decides whether to pull the rule via
 *    the description; never auto-applied). The body is the SKILL.md BODY
 *    (frontmatter stripped). Cursor's rule format has no references concept,
 *    so references are dropped (documented in the S10 spec risks — the body is
 *    the surface).
 *
 * The `target` defaults to `'claude'` for backward compatibility with every
 * existing caller; the verbatim branch produces byte-identical output to v1.1
 * (the regression anchor).
 */
export function compileSkill(skill: BuiltinSkill, target: CompileTarget = 'claude'): CompiledSkill {
  const res = validateSkill(skill);
  if (!res.ok) throw new Error(`Cannot compile ${skill.name}: ${res.errors.join('; ')}`);
  if (target === 'cursor') {
    return { name: skill.name, files: [{ path: [`${skill.name}.mdc`], content: toMdc(skill) }] };
  }
  // claude / agents-md / gemini / opencode → canonical verbatim format.
  const files = [
    { path: ['SKILL.md'], content: skill.skillMd },
    ...skill.references.map((r) => ({ path: ['references', r.name], content: r.content })),
  ];
  return { name: skill.name, files };
}

/**
 * Cursor `.mdc` rule transform — frontmatter `{description, globs, alwaysApply:
 * false}` + the SKILL.md body. The description drives Cursor's agent-decided
 * rule selection (per the S10 spec open-decision default: `alwaysApply: false`).
 * Cursor's rule format has no references/ concept, so the body alone is the
 * surface; references are dropped (documented risk in the spec).
 *
 * Frontmatter is YAML-serialized via the `yaml` package (already a dep) so
 * description escaping (colons, quotes, multi-line) is correct without hand
 * rolling. `lineWidth: 0` keeps descriptions on a single quoted line (predictable
 * byte shape; Cursor tolerates either). */
function toMdc(skill: BuiltinSkill): string {
  const frontmatter = stringifyYaml(
    {
      description: skill.frontmatter.description,
      globs: ['**/*'],
      alwaysApply: false,
    },
    { lineWidth: 0 },
  ).trimEnd();
  const body = bodyOf(skill.skillMd);
  // Cursor's `.mdc` shape: leading `---\n`, frontmatter, closing `---\n`, blank
  // line, body. Trailing newline so files concatenate cleanly on disk.
  return `---\n${frontmatter}\n---\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

/**
 * Compile an integration: validates the SKILL.md (same shape as builtins) +
 * renders the same per-skill files. When the integration's `runtime` widens
 * emission (`mcp-stdio`/`external-mcp`) AND it carries a non-null `mcp`
 * declaration, also expose a provider-neutral `hostMcp` server block the host
 * adapter may merge into the host MCP config (e.g. Claude's `.mcp.json`).
 *
 * For `gated-write-proxy` (ClickUp) + `none` → no `hostMcp` (writes route
 * through Noir's own MCP tool; the host MCP config is unchanged). For
 * `mcp-stdio` the hostMcp is exposed (the compiler widens emission); the
 * Claude adapter still does not emit a NEW server entry for it (Noir's own
 * `noir mcp serve` entry already covers it).
 */
export function compileIntegration(
  integration: IntegrationSkill,
  target: CompileTarget = 'claude',
): CompiledIntegration {
  // Validate the skill half first (throws on a bad SKILL.md — same path as
  // builtins). compileSkill returns a base CompiledSkill; we layer hostMcp on.
  const base = compileSkill(integration, target);
  const { runtime, mcp } = integration.declaration;
  if (runtimeEmitsHostMcp(runtime) && mcp !== null) {
    return {
      ...base,
      hostMcp: {
        serverName: integration.name,
        command: mcp.command,
        args: mcp.args,
        transport: mcp.transport,
        url: mcp.url,
        env: mcp.env,
      },
    };
  }
  return base;
}

export async function emitSkillsToDir(
  targetDir: string,
  opts: { builtinDir?: string; integrationsDir?: string; includeIntegrations?: boolean } = {},
): Promise<EmitSummary> {
  const { builtins, integrations } = discoverAll({
    builtinDir: opts.builtinDir,
    integrationsDir: opts.integrationsDir,
  });
  const emitIntegrations = opts.includeIntegrations ?? true;
  // Validate the whole pack before writing anything (fail-fast, atomic-ish).
  for (const s of builtins) {
    const res = validateSkill(s);
    if (!res.ok) throw new Error(`Invalid builtin skill ${s.name}: ${res.errors.join('; ')}`);
  }
  if (emitIntegrations) {
    for (const i of integrations) {
      const res = validateSkill(i);
      if (!res.ok) throw new Error(`Invalid integration ${i.name}: ${res.errors.join('; ')}`);
    }
  }
  await mkdir(targetDir, { recursive: true });
  let references = 0;
  const emitted: string[] = [];
  const integrationNames: string[] = [];
  for (const s of builtins) {
    const compiled = compileSkill(s, 'claude');
    for (const f of compiled.files) {
      const dest = join(targetDir, s.name, ...f.path);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.content, 'utf8');
      if (f.path[0] !== 'SKILL.md') references++;
    }
    emitted.push(s.name);
  }
  if (emitIntegrations) {
    for (const i of integrations) {
      const compiled = compileIntegration(i, 'claude');
      for (const f of compiled.files) {
        const dest = join(targetDir, i.name, ...f.path);
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, f.content, 'utf8');
        if (f.path[0] !== 'SKILL.md') references++;
      }
      // `hostMcp` is NOT written per-skill — it is surfaced to the host adapter
      // (via discoverAll/compileIntegration) to merge into the host's single
      // MCP config (e.g. `.mcp.json`). Wiring lives in cli/daemon (X-T2 seam).
      emitted.push(i.name);
      integrationNames.push(i.name);
    }
  }

  // --- T2: prune stale `noir-*` dirs from the managed namespace -------------
  // Idempotent hygiene: a previous Noir version may have shipped a builtin that
  // was since renamed/removed (e.g. `noir-old-thing`). Each `noir sync`
  // re-writes the CURRENT pack but a stale dir would otherwise linger forever.
  // After emit, scan `targetDir` for `noir-`-prefixed dirs NOT in the emitted
  // set and remove them. ONLY the `noir-` namespace — user skills without the
  // prefix are NEVER touched (they are not Noir's to manage).
  const keep = new Set(emitted);
  const pruned: string[] = [];
  let entries: string[] = [];
  try {
    entries = await readdir(targetDir, { withFileTypes: true })
      .then((ents) => ents.filter((e) => e.isDirectory() && e.name.startsWith('noir-')))
      .then((ents) => ents.map((e) => e.name));
  } catch {
    entries = []; // targetDir vanished between the mkdir above and now — nothing to prune.
  }
  for (const name of entries) {
    if (keep.has(name)) continue;
    // Best-effort removal: a failure to remove a stale dir must NOT fail the
    // emit (the fresh skills are already on disk and valid). Surface it via the
    // summary so a caller can warn; the next sync will try again.
    try {
      await rm(join(targetDir, name), { recursive: true, force: true });
      pruned.push(name);
    } catch {
      // Swallow — stale-dir pruning is hygienic, not correctness-critical.
    }
  }

  return { dir: targetDir, emitted, references, integrations: integrationNames, pruned };
}

// Convenience for callers/tests that already hold raw markdown (unused by emit path;
// kept so adapters/tests can validate a single in-memory skill without a dir).
export { discoverAll, discoverBuiltin };
