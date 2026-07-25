import { join, relative } from 'node:path';
import {
  AGENTS_MD_FILENAME,
  type EmitContext,
  emitAgentsMd,
  type HostAdapter,
  type HostId,
  resolveAdapter,
} from '@noir-ai/adapters';
import {
  CONTEXT_BLOCK,
  IGNORE_BLOCK,
  type ManagedBlock,
  managedBlock,
  NOIR_DIR,
  paths,
  RULES_BLOCK,
} from '@noir-ai/core';
import type { WriteMode } from './writers.js';

/**
 * Declarative scaffold manifest — the single source of truth for what
 * `init` / `create` / `sync` emit. Each entry is one artifact, tagged with its
 * write {@link WriteMode} so the orchestrator can dispatch without knowing
 * what's inside.
 *
 * FAITHFULNESS CONTRACT (S-T1 → S-T2 → S10): this table is a strict superset of
 * the artifacts `packages/cli/src/{init,sync}.ts` wrote pre-Slice-S. The cli
 * refactor (S-T2) replaced those ad-hoc writers with a call into `scaffold()`;
 * the byte-for-byte output MUST stay equivalent for first-run init. S10 makes
 * the manifest HOST-PARAMETRIC: {@link buildManifest} now returns host-agnostic
 * entries + a {@link buildHostArtifacts} call that materializes per-host files
 * (AGENTS.md always; CLAUDE.md/GEMINI.md/.cursor/.../opencode.json per host)
 * via the resolved adapter. The claude output stays byte-identical to v1.1
 * EXCEPT the additive root `AGENTS.md` (the 32-platform universal standard —
 * Claude reads it natively, and every other host already required it).
 *
 * Path-derivation: repo-relative POSIX strings that mirror
 * `@noir-ai/core/layout.ts` (`paths.*`). The test suite asserts
 * `join(root, entry.path) === paths.X(root)` for every entry layout knows
 * about, so a layout rename is caught here instead of silently drifting.
 */

/** S10: `HostTag` is now the SAME `HostId` enum the adapter registry uses
 *  (re-exported so existing imports keep working). Pre-S10 this was the
 *  literal `'claude'`; widening to `HostId` lets one manifest serve every host
 *  via the orchestrator's host filter + {@link buildHostArtifacts}. */
export type HostTag = HostId;

export interface ManifestEntry {
  /** Repo-relative POSIX path (forward slashes). Orchestrator joins with root. */
  path: string;
  mode: WriteMode;
  /** Host tag; entry is skipped when opts.host !== entry.host.
   *  Undefined = host-agnostic (every host emits it). */
  host?: HostTag;
  /** Required for `managedBlock` mode: the named block to re-emit. */
  block?: ManagedBlock;
  /** Literal content (`regenerate`/`skipIfExists`) or literal region BODY
   *  (`managedBlock` — the orchestrator wraps it with the block markers).
   *  Mutually exclusive with {@link template}. */
  content?: string;
  /** Template name (resolved by `template-loader`) for content/body.
   *  Mutually exclusive with {@link content}. */
  template?: string;
  /** One-line human description for `noir doctor` + logs. */
  description?: string;
}

export type BuildManifestContext = {
  /** Absolute repo root. Added in S10 so {@link buildHostArtifacts} can resolve
   *  absolute adapter paths (`adapter.mcpConfigPath({root})`, etc.) to the
   *  manifest's repo-relative POSIX shape. */
  root: string;
  /** Canonical project id (already created/read by the orchestrator). */
  projectId: string;
  /** Target host. Drives {@link buildHostArtifacts} via `resolveAdapter(host)`. */
  host: HostTag;
  /** MCP transport the host should use to reach Noir. */
  transport: 'stdio' | 'streamable-http';
  /** Required when transport is `streamable-http`. */
  url?: string;
};

// --- named managed blocks ----------------------------------------------------

/** Co-owned NOIR.md auto-brief region. Defined locally (not exported from
 *  core) because core's keystone-K named instances cover only the three
 *  regions core itself writes (context/rules/ignore); the brief is the
 *  scaffold engine's own. Uses the SAME `managedBlock()` factory so marker
 *  shape stays consistent with the rest of the family. */
export const BRIEF_BLOCK: ManagedBlock = managedBlock('brief', 'html');

// --- repo-relative path constants (mirror @noir-ai/core/layout.ts) -----------
// Inlined as string literals so the manifest has zero runtime dep on layout
// for path strings; the test suite cross-checks against `paths.*`.

const P = {
  projectId: `${NOIR_DIR}/project.id`,
  config: `${NOIR_DIR}/config.yml`,
  noirMd: `${NOIR_DIR}/NOIR.md`,
  rulesMd: `${NOIR_DIR}/rules/RULES.md`,
} as const;

// Aliases for the parity test (kept here so a layout rename breaks the test
// at the same site the literal lives, not in a far-off helper).
export const MANIFEST_PATH_PARITY: ReadonlyArray<
  [entryPath: string, layoutFn: (root: string) => string]
> = [
  [P.projectId, paths.projectId],
  [P.config, paths.config],
  [P.noirMd, paths.noirMd],
  [P.rulesMd, paths.rulesMd],
];

/**
 * Build the manifest for a given ctx. Pure (no I/O). The orchestrator calls
 * this once per scaffold run; tests assert the shape is stable.
 *
 * S10 structure: the manifest is now `[...hostAgnosticEntries(ctx), ...hostSpecificEntries(ctx)]`
 * where the host-specific half comes from {@link buildHostArtifacts} (driven by
 * `resolveAdapter(ctx.host)`). The host-agnostic half is unchanged from v1.1
 * (canonical `.noir/` store + ignore files).
 *
 * Mode-tagging rationale per artifact (see S-T1 report for the full table):
 *  - `project.id`  → skipIfExists. First init writes a fresh id; re-init MUST
 *    NOT overwrite — that would orphan the indexed store DB named after it.
 *  - `config.yml`  → skipIfExists. User-owned; the seed is written once.
 *    (The seed renders `host: {{host}}` so a `--host gemini` init persists the
 *    chosen host for `noir sync` to read back.)
 *  - `NOIR.md`     → managedBlock (BRIEF_BLOCK). Auto-brief is co-owned.
 *  - `RULES.md`    → skipIfExists. User-owned working-contract seed.
 *  - ignore files  → managedBlock (IGNORE_BLOCK). Matches syncIgnores.
 *  - host entries  → SEE {@link buildHostArtifacts} (regenerate / managedBlock).
 */
export function buildManifest(ctx: BuildManifestContext): ManifestEntry[] {
  return [...hostAgnosticEntries(ctx), ...buildHostArtifacts(resolveAdapter(ctx.host), ctx)];
}

/** The host-agnostic canonical-store + ignore entries — identical bytes for
 *  every host. Split out so {@link buildHostArtifacts} can be unit-tested in
 *  isolation and so the doctor's host-artifacts check can reason about the
 *  host-specific half alone. */
function hostAgnosticEntries(ctx: BuildManifestContext): ManifestEntry[] {
  return [
    {
      path: P.projectId,
      mode: 'skipIfExists',
      content: `${ctx.projectId}\n`,
      description: 'canonical project id (store DB is named after it)',
    },
    {
      path: P.config,
      mode: 'skipIfExists',
      template: 'config.yml.tmpl',
      description: 'user config seed (host + mode)',
    },
    {
      path: P.noirMd,
      mode: 'managedBlock',
      block: BRIEF_BLOCK,
      template: 'noir.md.tmpl',
      description: 'NOIR.md auto-brief (project id pointer)',
    },
    {
      path: P.rulesMd,
      mode: 'skipIfExists',
      template: 'rules-seed.md.tmpl',
      description: 'AI working-rules seed',
    },

    // --- ignore files (host-agnostic; co-owned via IGNORE_BLOCK) ------------
    {
      path: '.gitignore',
      mode: 'managedBlock',
      block: IGNORE_BLOCK,
      template: 'gitignore.tmpl',
      description: '.gitignore noir managed block',
    },
    {
      path: '.dockerignore',
      mode: 'managedBlock',
      block: IGNORE_BLOCK,
      template: 'dockerignore.tmpl',
      description: '.dockerignore noir managed block',
    },
    {
      path: '.npmignore',
      mode: 'managedBlock',
      block: IGNORE_BLOCK,
      template: 'npmignore.tmpl',
      description: '.npmignore noir managed block',
    },
    {
      path: '.prettierignore',
      mode: 'managedBlock',
      block: IGNORE_BLOCK,
      template: 'prettierignore.tmpl',
      description: '.prettierignore noir managed block',
    },
  ];
}

// ---------------------------------------------------------------------------
// S10 — host-specific artifact generation. One entry point: `buildHostArtifacts`.
// ---------------------------------------------------------------------------

/** Context shape passed to {@link buildHostArtifacts}. A strict subset of
 *  {@link BuildManifestContext} (no `projectId`/`host` — the adapter IS the
 *  resolved host, and host artifacts never need the project id). Exported
 *  separately so callers + tests can name the narrower contract. */
export interface BuildHostArtifactsContext {
  root: string;
  transport: 'stdio' | 'streamable-http';
  url?: string;
}

/**
 * Materialize the host-specific manifest entries from a resolved adapter.
 * SINGLE entry point — no scattered `if (host === '…')` conditionals in the
 * orchestrator. Returns entries in emission order:
 *
 *   1. **AGENTS.md** (universal, every host) — `regenerate` at
 *      `adapter.agentsMdPath(ctx)` (default `<root>/AGENTS.md`), content from
 *      the shared `emitAgentsMd(ctx)` helper. AGENTS.md is the 32-platform
 *      baseline (Claude Code, Codex, Cursor, Gemini CLI, Junie, … all read it
 *      natively), so every host — including claude — emits it.
 *   2. **Host-native context file** — emitted ONLY for hosts whose `emitContext`
 *      is NOT the AGENTS.md content (i.e. the host has its OWN context file
 *      with a distinct syntax). Concretely: claude → `CLAUDE.md` (CONTEXT +
 *      RULES managed blocks, byte-identical to v1.1 via templates); gemini →
 *      `GEMINI.md` (CONTEXT + RULES managed blocks with Gemini's bare `@`
 *      import syntax). For `agents-md`/`cursor`/`opencode` the context IS the
 *      AGENTS.md (already emitted in step 1) → SKIP to avoid a duplicate.
 *   3. **Host rules** (separate file, when applicable) — cursor →
 *      `.cursor/rules/noir-rules.mdc` (`adapter.emitRules(ctx)`, regenerate).
 *      Claude's rules live IN CLAUDE.md (step 2); gemini's IN GEMINI.md (step
 *      2); agents-md/opencode's IN AGENTS.md (step 1) — no separate file.
 *   4. **Host MCP config** — `regenerate` at `adapter.mcpConfigPath(ctx)`
 *      (default `<root>/.mcp.json` for claude), content from
 *      `adapter.emitMcpConfig(ctx, {transport,url})`. Claude KEEPS the template
 *      path (byte-identical parity with v1.1 + the .mcp.json parity test that
 *      compares against `claudeAdapter.emitMcpConfig`); other hosts use the
 *      adapter directly.
 *
 * Skills are OUT OF SCOPE here — the cli composes `emitSkillsToDir` with
 * `adapter.skillsDir` + the host's `CompileTarget` (claude → `.claude/skills/`
 * as SKILL.md; cursor → `.cursor/rules/<skill>/<skill>.mdc`; gemini/agents-md/
 * opencode have no skill dir → skip).
 */
export function buildHostArtifacts(
  adapter: HostAdapter,
  ctx: BuildHostArtifactsContext,
): ManifestEntry[] {
  const ectx: EmitContext = { root: ctx.root };
  const host = adapter.id;
  const entries: ManifestEntry[] = [];

  // 1. Universal AGENTS.md — always emitted (every host reads it).
  entries.push({
    path: hostRel(adapter.agentsMdPath?.(ectx) ?? join(ctx.root, AGENTS_MD_FILENAME), ctx.root),
    mode: 'regenerate',
    host,
    content: emitAgentsMd(ectx),
    description: `universal AGENTS.md (32-platform baseline; ${host} reads it natively)`,
  });

  // 2. Host-native context file (when distinct from AGENTS.md) + folded rules.
  switch (host) {
    case 'claude':
      // CLAUDE.md keeps template-based bodies — byte-identical to v1.1 (the
      // scaffold.test.ts parity gates compare against claudeAdapter.emitContext
      // + emitRules; the templates render to the same body bytes).
      entries.push({
        path: 'CLAUDE.md',
        mode: 'managedBlock',
        host,
        block: CONTEXT_BLOCK,
        template: 'claude-context-block.md.tmpl',
        description: 'CLAUDE.md context @import block',
      });
      entries.push({
        path: 'CLAUDE.md',
        mode: 'managedBlock',
        host,
        block: RULES_BLOCK,
        template: 'claude-rules-block.md.tmpl',
        description: 'CLAUDE.md rules @import block',
      });
      break;
    case 'gemini':
      // GEMINI.md carries CONTEXT_BLOCK + RULES_BLOCK with Gemini's bare
      // `@file` import syntax (no `@import` keyword, no quotes — distinct from
      // Claude's form). Emitted as TWO managed regions so user content outside
      // the markers survives `noir sync` (same write path as CLAUDE.md — the
      // multi-region atomic `managedBlocks` writer).
      entries.push({
        path: 'GEMINI.md',
        mode: 'managedBlock',
        host,
        block: CONTEXT_BLOCK,
        content: '@.noir/NOIR.md',
        description: 'GEMINI.md context @-import block',
      });
      entries.push({
        path: 'GEMINI.md',
        mode: 'managedBlock',
        host,
        block: RULES_BLOCK,
        content: '@.noir/rules/RULES.md',
        description: 'GEMINI.md rules @-import block',
      });
      break;
    case 'agents-md':
    case 'cursor':
    case 'opencode':
      // emitContext IS the AGENTS.md content (already emitted in step 1) →
      // no separate context file. Rules either folded into AGENTS.md
      // (agents-md/opencode — the `@.noir/rules/RULES.md` import covers them)
      // OR emitted as a separate .mdc below (cursor — step 3).
      break;
  }

  // 3. Host rules as a SEPARATE file (only cursor — its .mdc rule format is
  //    distinct from the AGENTS.md body, and the agent decides whether to
  //    apply it via the `description` frontmatter field).
  if (host === 'cursor' && adapter.emitRules) {
    entries.push({
      path: '.cursor/rules/noir-rules.mdc',
      mode: 'regenerate',
      host,
      content: adapter.emitRules(ectx),
      description: 'Cursor noir-rules .mdc (agent-decided via description; alwaysApply:false)',
    });
  }

  // 4. Host MCP config. Claude keeps the template path (byte-identical parity
  //    gate); other hosts use adapter.emitMcpConfig directly.
  const mcpAbs = adapter.mcpConfigPath?.(ectx) ?? join(ctx.root, '.mcp.json');
  const mcpRel = hostRel(mcpAbs, ctx.root);
  if (host === 'claude') {
    const mcpTemplate =
      ctx.transport === 'streamable-http' ? 'mcp.http.json.tmpl' : 'mcp.stdio.json.tmpl';
    entries.push({
      path: mcpRel,
      mode: 'regenerate',
      host,
      template: mcpTemplate,
      description: 'host MCP server pointer',
    });
  } else {
    const mcpContent = `${adapter.emitMcpConfig(ectx, {
      transport: ctx.transport,
      ...(ctx.url !== undefined ? { url: ctx.url } : {}),
    })}\n`;
    entries.push({
      path: mcpRel,
      mode: 'regenerate',
      host,
      content: mcpContent,
      description: `${host} MCP server pointer`,
    });
  }

  return entries;
}

/** Convert an absolute path under `root` to a repo-relative POSIX string (the
 *  manifest's path shape). Throws if `abs` is NOT under `root` so a future
 *  adapter that returns a stray path fails loudly instead of producing a
 *  malformed manifest entry. */
function hostRel(abs: string, root: string): string {
  const rel = relative(root, abs);
  if (rel.length === 0 || rel.startsWith('..') || rel.startsWith('/')) {
    throw new Error(`buildHostArtifacts: path '${abs}' is not under root '${root}'`);
  }
  // Normalize any platform separators to POSIX (manifest paths are POSIX).
  return rel.replace(/\\/g, '/');
}
