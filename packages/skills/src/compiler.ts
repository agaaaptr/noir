import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { sha256Hex12, uniqueAsideSync } from '@noir-ai/core';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { discoverAll, discoverBuiltin } from './discover.js';
import { runtimeEmitsHostMcp } from './integrations-schema.js';
import {
  artifactPathDrift,
  chainedReferences,
  isWhatWhenDescription,
  lintWarnings,
  looksLikeWhenDescription,
  MAX_BODY_LINES,
  missingSections,
  withinLineBudget,
} from './quality.js';

// Re-exported for backward-compat — callers (hygiene tests, CLI) import
// `looksLikeWhenDescription` from './compiler.js'. The single source of truth
// is quality.ts; this alias keeps the old import surface stable.
export { looksLikeWhenDescription } from './quality.js';

import type {
  BuiltinSkill,
  CompiledIntegration,
  CompiledSkill,
  CompileTarget,
  EmitSummary,
  IntegrationSkill,
  SkillConflict,
  SkillConflictContext,
  SkillConflictResolution,
  SkillConflictResolver,
  SkillFrontmatter,
  ValidationResult,
} from './types.js';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const NAME_RE = /^noir-[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

export function validateSkill(skill: BuiltinSkill): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const { name, description, metadata } = skill.frontmatter;
  if (!name) errors.push('missing `name`');
  else if (!NAME_RE.test(name)) errors.push(`name "${name}" must match noir-<kebab>`);
  if (basename(skill.dir) !== name) {
    errors.push(`dir "${basename(skill.dir)}" must equal name "${name}"`);
  }
  if (!description?.trim()) errors.push('missing `description`');
  else if (description.length > MAX_DESC) errors.push(`description exceeds ${MAX_DESC} chars`);
  else if (!looksLikeWhenDescription(description)) {
    errors.push('description must state WHEN to trigger (e.g. "Use when…"), not WHAT it does');
  } else if (!isWhatWhenDescription(description)) {
    // C3: the description must ALSO carry a WHAT clause — the trigger phrase
    // alone (WHEN-only) fails. Errors, not warnings: it's part of the contract.
    errors.push('description must be WHAT+WHEN — a WHAT clause after the trigger phrase');
  }
  // C3 structural gate: metadata, required sections, line budget, one-level refs.
  if (!metadata?.category?.trim()) errors.push('missing `metadata.category`');
  if (!metadata?.version?.trim()) errors.push('missing `metadata.version`');
  const body = bodyOf(skill.skillMd);
  const missing = missingSections(body);
  for (const sec of missing) errors.push(`missing required section: ${sec}`);
  if (!withinLineBudget(body)) {
    errors.push(`body exceeds ${MAX_BODY_LINES}-line budget (${body.split('\n').length} lines)`);
  }
  const chained = chainedReferences(skill);
  for (const r of chained)
    errors.push(`reference "${r}" chains to another reference (must be one level deep)`);
  for (const r of skill.references) {
    if (!/^[a-z0-9-]+\.md$/i.test(r.name)) errors.push(`reference "${r.name}" must be <kebab>.md`);
    if (!r.content.trim()) errors.push(`reference "${r.name}" is empty`);
  }
  // C3 generated-artifact standard: no `.noir/` output-path drift in the body
  // or references (unknown dir, or a filename missing its type-code prefix).
  for (const d of artifactPathDrift(skill)) errors.push(d);
  // Soft warnings (lint-level) — advisory, non-failing.
  warnings.push(...lintWarnings(skill));
  return { ok: errors.length === 0, errors, warnings: warnings.length > 0 ? warnings : undefined };
}

/**
 * `lintSkill` — the C3 soft quality gate. Errors = `validateSkill` errors (a
 * skill that fails validation is broken); warnings = `quality.ts` style rules
 * (thin body, no examples, first-person narration, …). A skill can validate
 * clean yet still carry lint warnings the author should resolve.
 */
export function lintSkill(skill: BuiltinSkill): {
  name: string;
  errors: string[];
  warnings: string[];
} {
  const res = validateSkill(skill);
  return { name: skill.name, errors: res.errors, warnings: res.warnings ?? [] };
}

/**
 * Compile a builtin skill into the host-shaped `CompiledSkill`. The validator
 * runs for every target (a malformed skill is malformed in any format).
 *
 *  - `claude` | `agents-md` | `gemini` | `opencode` (the AGENTS.md-aligned
 *    hosts): canonical format copied verbatim — `SKILL.md` plus its
 *    `references/` siblings. These hosts read the same SKILL.md shape;
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
  opts: {
    builtinDir?: string;
    integrationsDir?: string;
    includeIntegrations?: boolean;
    /** S10 CompileTarget — selects the per-skill transform. Defaults to
     *  `'claude'` (the v1.1 verbatim SKILL.md shape) so every existing caller
     *  stays byte-identical. `'cursor'` compiles each skill to a `.mdc` rule
     *  file (frontmatter `description`/`globs`/`alwaysApply:false` + the
     *  SKILL.md body); the other targets map to the verbatim shape (their
     *  hosts have no skill concept, so emit is skipped upstream — but the
     *  default-verbatim policy keeps the signature total). */
    target?: CompileTarget;
    /** Policy for a skill file that exists AND differs from the compiled
     *  bytes, when no {@link onConflict} resolver is wired (or non-interactive).
     *  Default `'overwrite'` preserves the v1.2 behavior (every sync clobbers).
     *  `'preserve'` skips the differing file (the CI / non-TTY default the CLI
     *  threads via `buildConflictOpts`). */
    conflictPolicy?: 'overwrite' | 'preserve';
    /** Per-file conflict resolver. The CLI passes its single
     *  `buildConflictOpts().onConflict` (clack menu + diff preview + apply-to-
     *  all) through unchanged; structurally compatible with @noir-ai/create's
     *  `ConflictResolverReturn`. */
    onConflict?: SkillConflictResolver;
    /** Explicit interactivity flag (the engine reads THIS, not process.env,
     *  matching @noir-ai/create's hermetic-interactive contract). When `false`,
     *  the resolver is NEVER consulted (CI / --json never hangs on a prompt). */
    interactive?: boolean;
  } = {},
): Promise<EmitSummary> {
  const target: CompileTarget = opts.target ?? 'claude';
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
  const conflicts: SkillConflict[] = [];
  // Apply-to-all memory keyed by artifact CLASS. Skill emission shares one
  // decision across the run (a `noir sync` touching 8 skill files → 1 prompt)
  // when the resolver returns `{resolution, applyToAll: true}`.
  const memory = new Map<string, SkillConflictResolution>();
  const policy: 'overwrite' | 'preserve' = opts.conflictPolicy ?? 'overwrite';
  // Non-interactive guard. The bridge `NOIR_NON_INTERACTIVE` is set by the
  // bin's preAction under --json/--no-input; the explicit `interactive: false`
  // wins over the env (mirrors @noir-ai/create's hermetic flag). When false,
  // the resolver is NEVER consulted — differing files fall back to `policy`.
  const interactive =
    opts.interactive ??
    (process.env.NOIR_NON_INTERACTIVE === undefined || process.env.NOIR_NON_INTERACTIVE === '');

  /** Write a compiled skill file through the SAME conflict seam as
   *  `regenerate`: read existing; if differs, consult the resolver (when
   *  interactive + wired); record the conflict for the structured report. */
  const writeWithConflict = async (
    absDest: string,
    relDest: string,
    content: string,
    isReference: boolean,
  ): Promise<void> => {
    let existing: string | undefined;
    try {
      existing = await readFile(absDest, 'utf8');
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && existing !== content) {
      const MODE = 'skill' as const;
      let resolution: SkillConflictResolution;
      const remembered = memory.get(MODE);
      if (remembered !== undefined) {
        resolution = remembered;
      } else if (interactive && opts.onConflict !== undefined) {
        const ctx: SkillConflictContext = {
          relPath: relDest,
          existing,
          proposed: content,
          mode: MODE,
        };
        const ret = await opts.onConflict(ctx);
        const unwrapped: SkillConflictResolution = typeof ret === 'string' ? ret : ret.resolution;
        if (typeof ret !== 'string' && ret.applyToAll === true) {
          memory.set(MODE, unwrapped);
        }
        resolution = unwrapped;
      } else {
        resolution = policy === 'preserve' ? 'preserve' : 'replace';
      }
      conflicts.push({
        path: relDest,
        mode: MODE,
        similarity: similarity(existing, content),
        existingSha: sha256Hex12(existing),
        proposedSha: sha256Hex12(content),
        resolution,
      });
      if (resolution === 'cancel') {
        throw new Error(`skill emit cancelled by user at ${relDest}`);
      }
      if (resolution === 'preserve') {
        // Skip this file; the user's bytes stand. Do not count as a reference.
        return;
      }
      if (resolution === 'rename') {
        // Move the user's file aside (unique suffix), then write the compiled bytes.
        await renameAside(absDest, '.local');
      } else if (resolution === 'duplicate') {
        // Write the compiled bytes to <absDest>.noir; keep the user's file.
        await writeFile(await uniqueAside(absDest, '.noir'), content, 'utf8');
        return;
      }
      // 'replace' → fall through and overwrite.
    }
    await writeFile(absDest, content, 'utf8');
    if (isReference) references++;
  };

  // Cursor skills land FLAT under targetDir (`.cursor/rules/<name>.mdc`) —
  // Cursor's rule loader scans `.cursor/rules/*.mdc` and does NOT recurse into
  // per-name subdirs. The verbatim branch (claude/agents-md/gemini/opencode)
  // keeps the canonical nested layout (`<name>/SKILL.md` + `<name>/references/`).
  const flat = target === 'cursor';
  for (const s of builtins) {
    const compiled = compileSkill(s, target);
    for (const f of compiled.files) {
      const dest = flat ? join(targetDir, ...f.path) : join(targetDir, s.name, ...f.path);
      await mkdir(dirname(dest), { recursive: true });
      const rel = flat ? f.path.join('/') : [s.name, ...f.path].join('/');
      await writeWithConflict(dest, rel, f.content, f.path[0] !== 'SKILL.md');
    }
    emitted.push(s.name);
  }
  if (emitIntegrations) {
    for (const i of integrations) {
      const compiled = compileIntegration(i, target);
      for (const f of compiled.files) {
        const dest = flat ? join(targetDir, ...f.path) : join(targetDir, i.name, ...f.path);
        await mkdir(dirname(dest), { recursive: true });
        const rel = flat ? f.path.join('/') : [i.name, ...f.path].join('/');
        await writeWithConflict(dest, rel, f.content, f.path[0] !== 'SKILL.md');
      }
      // `hostMcp` is NOT written per-skill — it is surfaced to the host adapter
      // (via discoverAll/compileIntegration) to merge into the host's single
      // MCP config (e.g. `.mcp.json`). Wiring lives in cli/daemon.
      emitted.push(i.name);
      integrationNames.push(i.name);
    }
  }

  // --- Prune stale `noir-*` entries from the managed namespace ----------
  // Idempotent hygiene: a previous Noir version may have shipped a builtin that
  // was since renamed/removed (e.g. `noir-old-thing`). Each `noir sync`
  // re-writes the CURRENT pack but a stale entry would otherwise linger forever.
  // After emit, scan `targetDir` for `noir-`-prefixed entries NOT in the emitted
  // set and remove them. ONLY the `noir-` namespace — user skills without the
  // prefix are NEVER touched (they are not Noir's to manage).
  //
  // `assertNotUserOwned` guard: a `noir-*` entry whose content does NOT
  // match the canonical Noir-emitted shape (SKILL.md with `name: noir-…`
  // frontmatter, OR a `.mdc` with the cursor frontmatter) is treated as
  // USER-AUTHORED and LEFT ALONE. A user hand-rolling `noir-myown/SKILL.md`
  // must never be silently deleted by a sync.
  //
  // Shape awareness: the nested layout (claude/agents-md/gemini/opencode)
  // writes one `noir-<name>/` DIR per skill → prune stale DIRS. The cursor flat
  // layout writes one `noir-<name>.mdc` FILE per skill → prune stale .mdc FILES.
  // Cursor ALSO clears legacy `noir-<name>/` dirs (nesting residue) so an
  // upgrade from nested→flat does not leave orphans under `.cursor/rules/`.
  const keep = new Set(emitted);
  const pruned: string[] = [];
  const preservedUserOwned: string[] = [];
  let dirEntries: import('node:fs').Dirent[] = [];
  try {
    dirEntries = await readdir(targetDir, { withFileTypes: true });
  } catch {
    dirEntries = []; // targetDir vanished between the mkdir above and now — nothing to prune.
  }
  for (const ent of dirEntries) {
    if (!ent.name.startsWith('noir-')) continue;
    if (flat) {
      // Cursor flat layout — prune stale FILES (`noir-<name>.mdc`) + legacy
      // nested DIRS (`noir-<name>/`) from a sync.
      if (ent.isFile()) {
        const mdcMatch = ent.name.match(/^(noir-[a-z0-9]+(?:-[a-z0-9]+)*)\.mdc$/);
        const skillName = mdcMatch?.[1];
        if (skillName && keep.has(skillName)) continue;
        // `assertNotUserOwned`: a `.mdc` without canonical cursor
        // frontmatter (globs + alwaysApply) was hand-rolled by the user; skip.
        if (await isUserOwnedMdc(join(targetDir, ent.name))) {
          preservedUserOwned.push(ent.name);
          continue;
        }
      } else if (ent.isDirectory()) {
        // Legacy cursor nested dir — clear unconditionally (the flat
        // layout has NO `noir-{name}/` dirs under .cursor/rules/; any such dir
        // is stale by definition, regardless of name overlap with the current
        // pack — the fresh `.mdc` file is what's kept, not the dir).
        // Guard: skip if NONE of the `.mdc` files inside look Noir-emitted
        // (canonical cursor frontmatter) — a user hand-rolling a noir-X/ dir
        // with arbitrary content is preserved.
        if (await isUserOwnedCursorLegacyDir(join(targetDir, ent.name))) {
          preservedUserOwned.push(ent.name);
          continue;
        }
      } else {
        continue;
      }
    } else {
      // Nested layout — prune stale DIRS only (the canonical shape).
      if (!ent.isDirectory()) continue;
      if (keep.has(ent.name)) continue;
      // `assertNotUserOwned`: a `noir-*/` dir whose SKILL.md does not
      // carry canonical Noir frontmatter (`name: noir-…`) is user-authored.
      if (await isUserOwnedSkillDir(join(targetDir, ent.name))) {
        preservedUserOwned.push(ent.name);
        continue;
      }
    }
    // Best-effort removal: a failure to remove a stale entry must NOT fail the
    // emit (the fresh skills are already on disk and valid). Surface it via the
    // summary so a caller can warn; the next sync will try again.
    try {
      await rm(join(targetDir, ent.name), { recursive: true, force: true });
      pruned.push(ent.name);
    } catch {
      // Swallow — stale-entry pruning is hygienic, not correctness-critical.
    }
  }

  return {
    dir: targetDir,
    emitted,
    references,
    integrations: integrationNames,
    pruned,
    ...(preservedUserOwned.length > 0 ? { preservedUserOwned } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
  };
}

/** `assertNotUserOwned` for the nested layout: a `noir-{name}/` dir is
 *  Noir-managed iff it contains a SKILL.md whose YAML frontmatter carries a
 *  `name:` matching `noir-<dir>`. Missing SKILL.md, missing frontmatter, or a
 *  non-matching name ⇒ user-authored (left alone). Best-effort: any IO error
 *  ⇒ treat as user-owned (the safe default — never silently delete). */
async function isUserOwnedSkillDir(dirAbs: string): Promise<boolean> {
  try {
    const skillMd = await readFile(join(dirAbs, 'SKILL.md'), 'utf8');
    const m = skillMd.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return true; // no frontmatter at all → user-authored
    const fm = parseYaml(m[1] ?? '') as { name?: unknown };
    const dirName = basename(dirAbs);
    return typeof fm?.name !== 'string' || fm.name !== dirName;
  } catch {
    return true; // ENOENT (no SKILL.md) or parse error → user-authored (safe)
  }
}

/** `assertNotUserOwned` for the cursor flat layout: a `noir-*.mdc` file
 *  is Noir-managed iff its YAML frontmatter carries `alwaysApply:` (the cursor
 *  shape the compiler always emits). Missing frontmatter / no `alwaysApply` ⇒
 *  user-authored. */
async function isUserOwnedMdc(fileAbs: string): Promise<boolean> {
  try {
    const md = await readFile(fileAbs, 'utf8');
    const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return true;
    const fm = parseYaml(m[1] ?? '') as { alwaysApply?: unknown };
    return fm?.alwaysApply === undefined;
  } catch {
    return true;
  }
}

/** `assertNotUserOwned` for the cursor flat-layout's legacy-nested-dir
 *  case: a Noir sync left `noir-{name}/noir-{name}.mdc` behind. The dir
 *  is Noir-managed iff at least one `.mdc` inside carries canonical cursor
 *  frontmatter (`alwaysApply:`). Absent / hand-rolled content ⇒ user-authored.
 *  Empty dir ⇒ treat as user-owned (safe — never silently delete). */
async function isUserOwnedCursorLegacyDir(dirAbs: string): Promise<boolean> {
  try {
    const entries = await readdir(dirAbs);
    if (entries.length === 0) return true;
    let sawCanonical = false;
    for (const name of entries) {
      if (!name.endsWith('.mdc')) continue;
      if (!(await isUserOwnedMdc(join(dirAbs, name)))) {
        sawCanonical = true;
        break;
      }
    }
    return !sawCanonical;
  } catch {
    return true; // ENOENT or unreadable → safe default (preserve)
  }
}

/** LCS similarity in [0,1]. Local copy (skills has no create dependency)
 *  so the structured report's `similarity` matches the engine's algorithm. */
function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = a.split('\n');
  const B = b.split('\n');
  if (A.length === 0 && B.length === 0) return 1;
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    const dpi = dp[i] ?? [];
    const dpi1 = dp[i + 1] ?? [];
    const ai = A[i] ?? '';
    for (let j = m - 1; j >= 0; j--) {
      const bj = B[j] ?? '';
      dpi[j] = ai === bj ? (dpi1[j + 1] ?? 0) + 1 : Math.max(dpi1[j] ?? 0, dpi[j + 1] ?? 0);
    }
  }
  const lcs = dp[0]?.[0] ?? 0;
  return n + m === 0 ? 1 : (2 * lcs) / (n + m);
}

/** Pick a fresh `<abs><suffix>` aside path that does NOT exist (mirrors
 *  @noir-ai/create's `uniqueAside`). Used by the `rename`/`duplicate` resolutions
 *  so the user's bytes never get silently clobbered. */
async function renameAside(abs: string, suffix: string): Promise<void> {
  const { rename } = await import('node:fs/promises');
  const dest = await uniqueAside(abs, suffix);
  await rename(abs, dest);
}

async function uniqueAside(abs: string, suffix: string): Promise<string> {
  return uniqueAsideSync(abs, suffix);
}

// Convenience for callers/tests that already hold raw markdown (unused by emit path;
// kept so adapters/tests can validate a single in-memory skill without a dir).
export { discoverAll, discoverBuiltin };
