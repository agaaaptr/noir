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
 * FAITHFULNESS CONTRACT (S-T1 → S-T2): this table is a strict superset of the
 * artifacts `packages/cli/src/{init,sync}.ts` write today. The cli refactor
 * (S-T2) replaces those ad-hoc writers with a call into `scaffold()`; the
 * byte-for-byte output MUST stay equivalent for first-run init. Deviations are
 * documented per-entry below and aggregated in the S-T1 report.
 *
 * Path-derivation: repo-relative POSIX strings that mirror
 * `@noir-ai/core/layout.ts` (`paths.*`). The test suite asserts
 * `join(root, entry.path) === paths.X(root)` for every entry layout knows
 * about, so a layout rename is caught here instead of silently drifting.
 */

export type HostTag = 'claude';

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
  /** Canonical project id (already created/read by the orchestrator). */
  projectId: string;
  /** Target host. Only `'claude'` is shipped today; the field exists so a
   *  future host filter doesn't require a manifest shape change. */
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
 * Mode-tagging rationale per artifact (see S-T1 report for the full table):
 *  - `project.id`  → skipIfExists. First init writes a fresh id; re-init MUST
 *    NOT overwrite — that would orphan the indexed store DB named after it.
 *    (Predecessor `init.ts` overwrote on every run; that was a latent bug.
 *    The spec's idempotent-re-run acceptance criterion requires skipIfExists
 *    here. BEHAVIOR CHANGE for re-init only; first-run is identical.)
 *  - `config.yml`  → skipIfExists. User-owned; the seed is written once.
 *    (Predecessor `init.ts` overwrote; spec matrix says skip_if_exists.
 *    BEHAVIOR CHANGE for re-init only.)
 *  - `NOIR.md`     → managedBlock (BRIEF_BLOCK). Auto-brief is co-owned: Noir
 *    re-emits the project-id pointer; user can keep notes outside the
 *    markers. (Predecessor `init.ts` overwrote the whole file with no
 *    markers. First-run output GAINS markers — see S-T1 report.)
 *  - `RULES.md`    → skipIfExists. User-owned working-contract seed.
 *    (Matches the existing `if (!existsSync)` guard in init.ts and sync.ts.)
 *  - `.mcp.json`   → regenerate. Pure pointer derived from transport/url.
 *  - `CLAUDE.md`   → managedBlock (CONTEXT_BLOCK + RULES_BLOCK). Matches init.
 *  - ignore files  → managedBlock (IGNORE_BLOCK). Matches syncIgnores.
 */
export function buildManifest(ctx: BuildManifestContext): ManifestEntry[] {
  const mcpTemplate =
    ctx.transport === 'streamable-http' ? 'mcp.http.json.tmpl' : 'mcp.stdio.json.tmpl';

  return [
    // --- canonical store under .noir/ (host-agnostic) -----------------------
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

    // --- host-side wiring (regenerate / managedBlock) -----------------------
    {
      path: '.mcp.json',
      mode: 'regenerate',
      host: ctx.host,
      template: mcpTemplate,
      description: 'host MCP server pointer',
    },
    {
      path: 'CLAUDE.md',
      mode: 'managedBlock',
      host: ctx.host,
      block: CONTEXT_BLOCK,
      template: 'claude-context-block.md.tmpl',
      description: 'CLAUDE.md context @import block',
    },
    {
      path: 'CLAUDE.md',
      mode: 'managedBlock',
      host: ctx.host,
      block: RULES_BLOCK,
      template: 'claude-rules-block.md.tmpl',
      description: 'CLAUDE.md rules @import block',
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
