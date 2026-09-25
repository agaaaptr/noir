import { existsSync } from 'node:fs';
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
  readWorkspaceMarker,
} from '@noir-ai/core';
import type { StackInfo } from './stack-detect.js';
import { render } from './template.js';
import type { SeedKind } from './template-history.js';
import { loadTemplate } from './template-loader.js';
import type { WriteMode } from './writers.js';

/**
 * Declarative scaffold manifest — the single source of truth for what
 * `init` / `create` / `sync` emit. Each entry is one artifact, tagged with its
 * write {@link WriteMode} so the orchestrator can dispatch without knowing
 * what's inside.
 *
 * FAITHFULNESS CONTRACT: this table is a strict superset of
 * the artifacts `packages/cli/src/{init,sync}.ts` wrote before the manifest
 * refactor. The cli refactor replaced those ad-hoc writers with a call into
 * `scaffold()`; the byte-for-byte output MUST stay equivalent for first-run
 * init. The manifest is HOST-PARAMETRIC: {@link buildManifest} returns
 * host-agnostic entries + a {@link buildHostArtifacts} call that materializes
 * per-host files
 * (CLAUDE.md/GEMINI.md for claude/gemini; AGENTS.md + .cursor/.../opencode.json
 * for agents-md/cursor/opencode) via the resolved adapter. The claude default
 * `noir init` stays BYTE-IDENTICAL to v1.1 — REMOVED the additive
 * root `AGENTS.md` (it was double-importing `.noir/NOIR.md` + RULES.md via
 * CLAUDE.md's existing @-imports; claude's native surface is CLAUDE.md alone).
 *
 * Path-derivation: repo-relative POSIX strings that mirror
 * `@noir-ai/core/layout.ts` (`paths.*`). The test suite asserts
 * `join(root, entry.path) === paths.X(root)` for every entry layout knows
 * about, so a layout rename is caught here instead of silently drifting.
 */

/** `HostTag` is the SAME `HostId` enum the adapter registry uses
 *  (re-exported so existing imports keep working); it used to be the
 *  literal `'claude'`. Widening it to `HostId` lets one manifest serve every
 *  host via the orchestrator's host filter + {@link buildHostArtifacts}. */
export type HostTag = HostId;

export interface ManifestEntry {
  /** Repo-relative POSIX path (forward slashes). Orchestrator joins with root. */
  path: string;
  mode: WriteMode;
  /** Opt-in flag for a DOC-ONLY seed — a file whose only job is to be read by a
   *  human. On an upgrade, a seed still byte-identical to what an older Noir
   *  shipped is refreshed in place rather than staying frozen at that older
   *  text forever; one the user edited is never refreshed (it goes to the
   *  ordinary conflict flow, which keeps the user's bytes by default).
   *
   *  Honored on the upgrade emit only. A fresh `init`/`create` either creates
   *  the file or leaves it alone, and `sync` does not emit seeds at all, so
   *  neither can observe the flag — the behavior change is confined to the one
   *  command a user runs to bring an initialized project up to date.
   *
   *  DOC-ONLY SEEDS ONLY. A file the user owns the contents of must never carry
   *  this flag: `.noir/.env`, `.noir/config.yml` and `.noir/project.id` are
   *  theirs to shape, and an upgrade that rewrote one of them would destroy
   *  exactly the work this engine exists to protect. Co-owned files (managed
   *  blocks) must not set it either — they have a three-way merge that
   *  preserves user edits, which is the better tool for a shared file.
   *
   *  Which recorded seed the bytes are compared against is declared separately
   *  in {@link REFRESHABLE_SEED_KIND}. */
  refreshIfStale?: true;
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
  /** Permission for a NEWLY created file (e.g. `0o600` for a credential seed).
   *  Applied only on creation — the `skipIfExists` contract means an existing
   *  file is not even opened. The orchestrator forwards this to the writer and
   *  reports it on the result as {@link ScaffoldResult.fileModes}; the mode of
   *  an existing credential file is re-asserted separately (`ensureOwnerOnly`).
   *  Ignored by every other write mode, whose targets are regenerated rather
   *  than seeded.
   *  NOTE: POSIX-only. Windows permissions are ACL-based and ignore it. */
  fileMode?: number;
  /** Required for `mergeJson` mode: the JSON patch object (or a template that
   *  renders to one). Merged into the existing file, preserving user keys. */
  patch?: Record<string, unknown>;
  /** Required for `mergeJson` mode: dedup substring for `hooks.*` entries — an
   *  existing entry whose command contains this is NOT re-added. */
  dedupSubstring?: string;
}

export type BuildManifestContext = {
  /** Absolute repo root. Needed so {@link buildHostArtifacts} can resolve
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
  /** The `command` value emitted into the host's MCP config for the stdio
   *  server. Defaults to `'noir'`; the orchestrator passes the absolute native
   *  shim path (`~/.noir/bin/noir`) when a native install is detected, so GUI
   *  MCP clients that don't read shell profiles can spawn the server. See
   *  `resolveNoirCommand()` in @noir-ai/core. */
  command: string;
  /** Detected stack — drives stack-aware ignore emission (.npmignore /
   *  .prettierignore only for JS; .dockerignore only when a Dockerfile is
   *  present; an unknown/empty stack ⇒ all four, for backward compat). */
  stack?: StackInfo;
  /** The `rules.enabled` switch from the project's `.noir/config.yml`. False
   *  drops the working-rules seed from the manifest, so no command emits or
   *  backfills `.noir/rules/RULES.md` for a project that opted out. Undefined
   *  (the schema's default state, and every caller that predates the switch)
   *  means enabled — a project with no `rules:` block emits the seed exactly
   *  as before. A file already on disk is never removed: dropping the entry
   *  removes the emission, not the file. */
  rulesEnabled?: boolean;
};

// --- named managed blocks ----------------------------------------------------

/** Co-owned NOIR.md auto-brief region. Defined locally (not exported from
 *  core) because core's own named block instances cover only the three
 *  regions core itself writes (context/rules/ignore); the brief is the
 *  scaffold engine's own. Uses the SAME `managedBlock()` factory so marker
 *  shape stays consistent with the rest of the family. */
export const BRIEF_BLOCK: ManagedBlock = managedBlock('brief', 'html');

/** Co-owned `.noir/README.md` runtime map. Defined locally
 *  for the same reason as {@link BRIEF_BLOCK}: the named
 *  instances in core cover only the regions core itself writes. The map describes
 *  paths that appear LATER in the project's life, so it must be re-emitted —
 *  `regenerate` would clobber a user's annotations and `skipIfExists` would
 *  freeze it at init time; a managed block keeps both sides honest. */
export const README_BLOCK: ManagedBlock = managedBlock('readme', 'html');

/** The one row of the `.noir/README.md` store map that describes the
 *  working-rules seed. The map ships as a single template because it documents
 *  the whole canonical store at once, but the rules row describes a file that
 *  only exists while `rules.enabled` is on. It is therefore dropped from the
 *  rendered text rather than kept in a second template variant: one template
 *  keeps the wording (and the surrounding table) in one place, and a test
 *  asserts the template still carries exactly one row with this prefix, so a
 *  reworded or renamed row fails loudly instead of silently surviving a
 *  switch-off emit.
 *
 *  A prefix match, not a full-line constant: the row's prose is free to change
 *  without a second edit here. */
const RULES_MAP_ROW_PREFIX = '| `rules/RULES.md` |';

/** Render the `.noir/README.md` store map: the shipped template, minus the
 *  working-rules row when the project has switched the seed off. With the
 *  switch on (and for every project that predates it) this is exactly what
 *  {@link renderEntry} produced from the plain template. */
function readmeMapContent(ctx: BuildManifestContext): string {
  const rendered = render(loadTemplate('noir-readme.md.tmpl'), ctx);
  if (ctx.rulesEnabled !== false) return rendered;
  return rendered
    .split('\n')
    .filter((line) => !line.startsWith(RULES_MAP_ROW_PREFIX))
    .join('\n');
}

// --- repo-relative path constants (mirror @noir-ai/core/layout.ts) -----------
// Inlined as string literals so the manifest has zero runtime dep on layout
// for path strings; the test suite cross-checks against `paths.*`.

const P = {
  projectId: `${NOIR_DIR}/project.id`,
  config: `${NOIR_DIR}/config.yml`,
  envExample: `${NOIR_DIR}/.env.example`,
  env: `${NOIR_DIR}/.env`,
  noirMd: `${NOIR_DIR}/NOIR.md`,
  rulesMd: `${NOIR_DIR}/rules/RULES.md`,
  readme: `${NOIR_DIR}/README.md`,
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
 * Which recorded seed each refreshable entry is compared against, keyed by the
 * path that emits it — see {@link ManifestEntry.refreshIfStale}.
 *
 * The history entries record the text of BOTH seeds, so the comparison has to
 * be told which one it is looking at. The manifest is what knows which path
 * holds which seed, and keeping that pairing in a table beside the path
 * constants means a path change breaks at the same site instead of silently
 * comparing `.noir/.env.example` against the recorded working-rules text — a
 * mismatch whose only symptom would be a file the user edited, overwritten.
 *
 * `manifest.test.ts` asserts this table and the flagged entries cover each
 * other, so a refreshable entry cannot be added without naming its seed.
 */
export const REFRESHABLE_SEED_KIND: Readonly<Record<string, SeedKind>> = {
  [P.envExample]: 'envExample',
  [P.rulesMd]: 'rulesSeed',
};

/**
 * Build the manifest for a given ctx. Pure (no I/O). The orchestrator calls
 * this once per scaffold run; tests assert the shape is stable.
 *
 * The manifest is `[...hostAgnosticEntries(ctx), ...hostSpecificEntries(ctx)]`
 * where the host-specific half comes from {@link buildHostArtifacts} (driven by
 * `resolveAdapter(ctx.host)`). The host-agnostic half is unchanged from v1.1
 * (canonical `.noir/` store + ignore files). {@link buildHostArtifacts}
 * emits AGENTS.md ONLY for agents-md/cursor/opencode (claude/gemini use their
 * own CLAUDE.md/GEMINI.md — emitting AGENTS.md too would double-import .noir/).
 *
 * Mode-tagging rationale per artifact:
 *  - `project.id`  → skipIfExists. First init writes a fresh id; re-init MUST
 *    NOT overwrite — that would orphan the indexed store DB named after it.
 *  - `config.yml`  → skipIfExists. User-owned; the seed is written once.
 *    (The seed renders `host: {{host}}` so a `--host gemini` init persists the
 *    chosen host for `noir sync` to read back.)
 *  - `NOIR.md`     → managedBlock (BRIEF_BLOCK). Auto-brief is co-owned.
 *  - `RULES.md`    → skipIfExists. User-owned working-contract seed.
 *  - `README.md`   → managedBlock (README_BLOCK). The `.noir/` runtime map is
 *    regenerated as the layout grows; user notes outside the markers survive.
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
  const entries: ManifestEntry[] = [
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
      // Refreshable: the variable set Noir documents grows between releases,
      // and this file is pure documentation the user is never asked to edit —
      // so an upgrade may replace an untouched older copy of it.
      path: P.envExample,
      mode: 'skipIfExists',
      template: 'env.example.tmpl',
      refreshIfStale: true,
      description: '.noir/.env.example committable documentation (never loaded)',
    },
    {
      // init creates the REAL env file, not just the example. The body is
      // all-comment, so the file parses to an EMPTY overlay and creating it
      // changes no behaviour — it exists so the user never has to copy the
      // example by hand. `fileMode: 0o600` because the file holds tokens the
      // moment the user edits it. The mode is applied when the file is created;
      // a copy that predates this contract (or that an editor saved by rename)
      // has its mode re-asserted on every init/sync run — see `ensureOwnerOnly`.
      path: P.env,
      mode: 'skipIfExists',
      template: 'config.env.tmpl',
      fileMode: 0o600,
      description: 'project-scoped env file (gitignored, 0600)',
    },
    {
      path: P.noirMd,
      mode: 'managedBlock',
      block: BRIEF_BLOCK,
      template: 'noir.md.tmpl',
      description: 'NOIR.md auto-brief (project id pointer)',
    },
    {
      // Refreshable: shipped as a starting contract the user is INVITED to
      // rewrite, so only the never-edited copy may be swapped for a newer one.
      path: P.rulesMd,
      mode: 'skipIfExists',
      template: 'rules-seed.md.tmpl',
      refreshIfStale: true,
      description: 'AI working-rules seed',
    },
    {
      // The `.noir/` runtime map — what init just wrote,
      // what appears later (and which command creates it), and where to go
      // next. Host-agnostic: it describes the canonical store, which every
      // host shares. Co-owned (README_BLOCK) so user notes survive while the
      // map stays current through `noir sync` / `init --upgrade`.
      //
      // Rendered here rather than left to `renderEntry` because one row of the
      // map depends on the project: the working-rules row is dropped when
      // `rules.enabled` is off (see {@link readmeMapContent}).
      path: P.readme,
      mode: 'managedBlock',
      block: README_BLOCK,
      content: readmeMapContent(ctx),
      description: '.noir/ runtime map (what exists now / what appears later)',
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
  // Stack-aware ignore emission. Only emit the ignore
  // files relevant to the detected stack. An unknown/empty stack (no language
  // markers, no package manager — e.g. a blank dir or undetectable project) ⇒
  // emit all four (backward-compatible with the pre-fix behavior).
  const isEmpty = (ctx.stack?.languages?.length ?? 0) === 0 && !ctx.stack?.packageManager;
  const isJs =
    isEmpty ||
    (ctx.stack?.languages?.some((l) => l === 'typescript' || l === 'javascript') ?? false) ||
    ['npm', 'pnpm', 'yarn'].includes(ctx.stack?.packageManager ?? '');
  const hasDocker =
    isEmpty ||
    existsSync(join(ctx.root, 'Dockerfile')) ||
    existsSync(join(ctx.root, 'docker-compose.yml')) ||
    existsSync(join(ctx.root, 'compose.yaml'));
  // The working-rules seed follows the project's own `rules.enabled` switch.
  const rulesEnabled = ctx.rulesEnabled !== false;
  return entries.filter((e) => {
    if (e.path === P.rulesMd) return rulesEnabled;
    if (e.path === '.npmignore' || e.path === '.prettierignore') return isJs;
    if (e.path === '.dockerignore') return hasDocker;
    return true;
  });
}

// Host-specific artifact generation. One entry point: `buildHostArtifacts`.

/** Context shape passed to {@link buildHostArtifacts}. A strict subset of
 *  {@link BuildManifestContext} (no `projectId`/`host` — the adapter IS the
 *  resolved host, and host artifacts never need the project id). Exported
 *  separately so callers + tests can name the narrower contract. */
export interface BuildHostArtifactsContext {
  root: string;
  transport: 'stdio' | 'streamable-http';
  url?: string;
  /** The `command` for the stdio MCP server entry (absolute native shim when a
   *  native install is detected, else `'noir'`). Passed through to
   *  `adapter.emitMcpConfig`. */
  command: string;
  /** The project's `rules.enabled` switch. False drops the rules `@`-import a
   *  host would otherwise emit (CLAUDE.md's rules block, GEMINI.md's rules
   *  block, AGENTS.md's rules import) so no host file points at a
   *  `.noir/rules/RULES.md` that the switch withheld. Undefined means enabled —
   *  byte-identical to every build that predates the switch. */
  rulesEnabled?: boolean;
}

/**
 * Materialize the host-specific manifest entries from a resolved adapter.
 * SINGLE entry point — no scattered `if (host === '…')` conditionals in the
 * orchestrator. Returns entries in emission order:
 *
 *   1. **AGENTS.md** (universal baseline) — `regenerate` at
 *      `adapter.agentsMdPath(ctx)` (default `<root>/AGENTS.md`), content from
 *      the shared `emitAgentsMd(ctx)` helper. Emitted ONLY for hosts whose
 *      `emitContext` IS the AGENTS.md content (agents-md, cursor, opencode) —
 *      for them AGENTS.md is the SINGLE native context surface AND carries the
 *      Noir working rules via its `@.noir/rules/RULES.md` import. claude and
 *      gemini have their OWN native context file (CLAUDE.md / GEMINI.md) that
 *      `@`-imports the canonical `.noir/` sources; emitting AGENTS.md too
 *      would IMPORT THOSE FILES TWICE into the host's context (2× tokens +
 *      drift risk), so for those two hosts AGENTS.md is SKIPPED. (Claude Code
 *      still discovers AGENTS.md at the repo root when present — users who
 *      want the universal file can drop one in by hand; Noir's auto-emission
 *      stays single-source per host.)
 *   2. **Host-native context file** — emitted ONLY for hosts whose `emitContext`
 *      is NOT the AGENTS.md content (i.e. the host has its OWN context file
 *      with a distinct syntax). Concretely: claude → `CLAUDE.md` (CONTEXT +
 *      RULES managed blocks, byte-identical to v1.1 via templates); gemini →
 *      `GEMINI.md` (CONTEXT + RULES managed blocks with Gemini's bare `@`
 *      import syntax). For `agents-md`/`cursor`/`opencode` the context IS the
 *      AGENTS.md (already emitted in step 1) → SKIP to avoid a duplicate.
 *      Rules live INSIDE the host's context file: claude's in CLAUDE.md,
 *      gemini's in GEMINI.md, agents-md/cursor/opencode's in AGENTS.md — NO
 *      host emits a separate rules file. (The prior cursor
 *      `.cursor/rules/noir-contract.mdc` host-rules pointer was REMOVED: it
 *      collided with the cursor flat-skill prune of `noir-*.mdc` under
 *      `.cursor/rules/`, and cursor's rules are already delivered via
 *      AGENTS.md's `@.noir/rules/RULES.md` import.)
 *
 *      That rules import/block is dropped for every host when
 *      `ctx.rulesEnabled` is false: the switch withholds the seed, so pointing
 *      a host at it would resolve to nothing. The context import is unaffected
 *      — the switch gates the rules, not the brief. A host file that already
 *      carries the rules region from when the switch was on keeps it: dropping
 *      the entry stops the emission, and nothing here rewrites a region out of
 *      an existing file.
 *   3. **Host MCP config** — `regenerate` at `adapter.mcpConfigPath(ctx)`
 *      (default `<root>/.mcp.json` for claude), content from
 *      `adapter.emitMcpConfig(ctx, {transport,url})`. Claude KEEPS the template
 *      path (byte-identical parity with v1.1 + the .mcp.json parity test that
 *      compares against `claudeAdapter.emitMcpConfig`) for a repo that has not
 *      joined a workspace; a joined repo — one carrying a `.noir/workspace.json`
 *      marker — gets the workspace entry instead, on every host, whatever
 *      transport the run asked for (see the entry's own comment below).
 *
 * Skills are OUT OF SCOPE here — the cli composes `emitSkillsToDir` with
 * `adapter.skillsDir` + the host's `CompileTarget` (claude → `.claude/skills/`
 * as SKILL.md; cursor → `.cursor/rules/<skill>.mdc` FLAT; gemini/
 * agents-md/opencode have no skill dir → skip).
 */
export function buildHostArtifacts(
  adapter: HostAdapter,
  ctx: BuildHostArtifactsContext,
): ManifestEntry[] {
  const rulesEnabled = ctx.rulesEnabled !== false;
  const ectx: EmitContext = { root: ctx.root, rulesEnabled };
  const host = adapter.id;
  const entries: ManifestEntry[] = [];

  // 1. AGENTS.md — emitted for hosts whose emitContext IS the AGENTS.md content
  //    (agents-md, cursor, opencode). SKIPPED for claude/gemini: their native
  //    CLAUDE.md / GEMINI.md already @-import the canonical .noir/ sources, so
  //    a root AGENTS.md would double-import (2× context tokens, drift risk).
  //    This also restores the claude default `noir init` to byte-identity with
  //    v1.1 (the prior additive AGENTS.md delta is removed).
  const emitsAgentsMd = host === 'agents-md' || host === 'cursor' || host === 'opencode';
  if (emitsAgentsMd) {
    entries.push({
      path: hostRel(adapter.agentsMdPath?.(ectx) ?? join(ctx.root, AGENTS_MD_FILENAME), ctx.root),
      mode: 'regenerate',
      host,
      content: emitAgentsMd(ectx),
      description: `AGENTS.md (${host}'s native context surface; @-imports .noir/)`,
    });
  }

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
      // The rules block only exists when the project HAS a rules file. With the
      // switch off the block is not emitted — a fresh project gets no dangling
      // `@import`, and a project that already carries the block from when the
      // switch was on keeps it (off stops the emission; it never cuts a region
      // out of a user's file).
      if (rulesEnabled) {
        entries.push({
          path: 'CLAUDE.md',
          mode: 'managedBlock',
          host,
          block: RULES_BLOCK,
          template: 'claude-rules-block.md.tmpl',
          description: 'CLAUDE.md rules @import block',
        });
      }
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
      // Same rule as claude's: no rules file, no rules import.
      if (rulesEnabled) {
        entries.push({
          path: 'GEMINI.md',
          mode: 'managedBlock',
          host,
          block: RULES_BLOCK,
          content: '@.noir/rules/RULES.md',
          description: 'GEMINI.md rules @-import block',
        });
      }
      break;
    case 'agents-md':
    case 'cursor':
    case 'opencode':
      // emitContext IS the AGENTS.md content (already emitted in step 1) →
      // no separate context file. Rules are carried by AGENTS.md's
      // `@.noir/rules/RULES.md` import (agents-md/cursor/opencode share that
      // universal surface — NO host emits a separate rules file).
      break;
  }

  // 3. Host MCP config. Claude keeps the template path for a repo that has not
  //    joined a workspace (byte-identical parity gate); every other case goes
  //    through the adapter, so the entry is rendered by the same code the host's
  //    own emitter uses.
  //
  //    A repo that has JOINED a workspace gets the workspace entry, and that
  //    decision belongs to the marker — not to the transport this run asked for.
  //    Membership is what decides how the host reaches the daemon (through the
  //    stdio bridge, which reads the token itself), so re-scaffolding must never
  //    drop a repo out of a workspace the marker still says it belongs to, nor
  //    write an address into its config. Reading the marker HERE, where the entry
  //    is chosen, means no caller can bypass it — `sync`, `init --force`,
  //    `create --force` and the doctor's expectation check all follow membership
  //    for free.
  const mcpAbs = adapter.mcpConfigPath?.(ectx) ?? join(ctx.root, '.mcp.json');
  const mcpRel = hostRel(mcpAbs, ctx.root);
  const workspace = readWorkspaceMarker(ctx.root);
  if (host === 'claude' && workspace === null) {
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
    const mcpContent = `${adapter.emitMcpConfig(
      ectx,
      workspace !== null
        ? // Joined: stdio + the workspace name, whatever transport was asked for.
          { transport: 'stdio', command: ctx.command, workspace }
        : {
            transport: ctx.transport,
            command: ctx.command,
            ...(ctx.url !== undefined ? { url: ctx.url } : {}),
          },
    )}\n`;
    entries.push({
      path: mcpRel,
      mode: 'regenerate',
      host,
      content: mcpContent,
      description:
        workspace !== null
          ? `${host} MCP server pointer (workspace "${workspace}")`
          : `${host} MCP server pointer`,
    });
  }

  // 4. SessionStart hook bootstrap (claude only). Three artifacts, three
  //    ownerships (research-validated "both + split" design):
  //      a. `.claude/settings.local.json` SessionStart entry — user-owned,
  //         written ONCE via mergeJson (init/create only, deduped by command
  //         substring). NEVER re-written by sync or `init --upgrade` (a
  //         re-emit would resurrect a hook the user removed); preserves
  //         permissions/env.
  //      b. `.noir/hooks/noir-session-start.mjs` — Noir-owned runner,
  //         regenerate (init + sync), emits additionalContext from router.md.
  //      c. `.noir/router.md` — co-owned mutable router contract, managedBlock
  //         (init + sync), user edits outside markers survive.
  if (host === 'claude') {
    const HOOK_DEDUP = 'noir-session-start';
    const hookEntry = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `"${ctx.root}/.noir/hooks/noir-session-start.mjs"`,
              },
            ],
          },
        ],
      },
    };
    entries.push({
      path: '.claude/settings.local.json',
      mode: 'mergeJson',
      host,
      content: JSON.stringify(hookEntry, null, 2),
      dedupSubstring: HOOK_DEDUP,
      description: 'SessionStart hook entry (user-owned, written once)',
    });
    entries.push({
      path: '.noir/hooks/noir-session-start.mjs',
      mode: 'regenerate',
      host,
      content: SESSION_START_HOOK_SCRIPT,
      description: 'SessionStart hook runner (Noir-owned, re-emitted)',
    });
    entries.push({
      path: '.noir/router.md',
      mode: 'managedBlock',
      host,
      block: CONTEXT_BLOCK,
      template: 'router.md.tmpl',
      description: 'skill router contract (co-owned managed block)',
    });
  }

  return entries;
}

/** The SessionStart hook runner. Reads `.noir/router.md` (the co-owned
 *  router contract) and emits it as `hookSpecificOutput.additionalContext` so
 *  Claude Code wraps it in a system reminder at the start of every session —
 *  deterministic, NOT in the skill-listing 1% budget. Kept small (<10k chars)
 *  so Claude never file-izes it. */
const SESSION_START_HOOK_SCRIPT = `#!/usr/bin/env node
// Noir SessionStart hook — injects the skill router contract at session start.
// The mutable contract lives in .noir/router.md (a Noir managed block, so user
// edits outside the markers survive noir sync). This script is a pure runner.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const ROUTER = join(ROOT, '.noir', 'router.md');

function main() {
  if (!existsSync(ROUTER)) {
    // No router contract (project not initialized / router removed) — silent.
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {} }));
    process.exit(0);
  }
  const contract = readFileSync(ROUTER, 'utf8').trim();
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { additionalContext: contract } }),
  );
}

main();
`;

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
