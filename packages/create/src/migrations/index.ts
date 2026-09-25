import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type HostId, mcpConfigPathFor, noirStdioArgs, TRANSPORT_KEYS } from '@noir-ai/adapters';
import {
  atomicWriteFile,
  loadProjectInfo,
  readWorkspaceMarker,
  resolveNoirCommand,
} from '@noir-ai/core';
import { render } from '../template.js';
import { isStaleSeed, type SeedKind } from '../template-history.js';
import { loadTemplate } from '../template-loader.js';
import { refreshSeed } from '../writers.js';
import type { MigrationResult, MigrationScript } from './types.js';

export { runMigrations } from './runner.js';
export type { MigrationContext, MigrationResult, MigrationScript } from './types.js';

/**
 * Migration registry — the linear history of scaffold-version upgrades.
 *
 * `CURRENT_SCAFFOLD_VERSION` is `1.3.0`; a project stamped at an older version
 * migrates through every entry whose window covers it. Four entries ship today:
 * the synthetic `1.0.0 → 1.0.0` runner-proof, the first REAL migration
 * `1.0.0 → 1.1.0` (which performs the transformation `skipIfExists` cannot),
 * `1.1.0 → 1.2.0`, which refreshes the doc-only seed whose text changed in
 * that release and carries the unchanged RULES.md seed forward for parity, and
 * `1.2.0 → 1.3.0`, which repairs the stale workspace pointer a repo that joined
 * a workspace under the older flow still carries.
 *
 * Convention:
 *  - `from`/`to` are bare `x.y.z` (no `v` prefix, no pre-release); the runner
 *    compares them numerically.
 *  - Every `run` MUST be idempotent and non-throwing (capture failures into
 *    `result.conflicts`). See {@link types.ts}.
 *  - Conflict resolution writes git-style markers inline — see
 *    {@link applyWithConflict} for the canonical helper.
 *  - Paths in `changed`/`conflicts` are repo-relative and POSIX-separated, like
 *    every other path the engine reports.
 */

/** Synthetic 1.0.0 → 1.0.0 migration. Proves the runner wires up; also
 *  demonstrates the conflict-marker path with a guarded, idempotent touch on
 *  `.noir/scaffold-version` only when explicitly asked via
 *  `NOIR_TEST_FORCE_CONFLICT`. It STAYS now that a real migration has landed:
 *  the real entry is a one-shot transformation of user content, while this one
 *  is the registry's permanent, side-effect-free smoke test for the runner and
 *  its conflict-marker plumbing. */
const synthetic: MigrationScript = {
  from: '1.0.0',
  to: '1.0.0',
  description: 'no-op synthetic migration (runner smoke test)',
  run: (ctx) => {
    const result: MigrationResult = { changed: [], conflicts: [], notes: [] };
    // The only "real" thing it does: when the env var is set, write a conflict
    // marker into `.noir/scaffold-version` so the runner's conflict plumbing is
    // exercised by tests. In normal operation this branch never fires and the
    // script is a true no-op.
    if (process.env.NOIR_TEST_FORCE_CONFLICT === '1' && !ctx.dryRun) {
      const file = join(ctx.root, '.noir', 'scaffold-version');
      if (existsSync(file)) {
        const prev = readFileSync(file, 'utf8');
        const merged = applyInlineConflict(prev, 'noir-scaffold=1.0.0\n', 'ours', 'theirs');
        writeFileSync(file, merged, 'utf8');
        result.conflicts.push('.noir/scaffold-version');
      }
    }
    result.notes.push('synthetic 1.0.0→1.0.0 migration ran');
    return result;
  },
};

// --- 1.0.0 → 1.1.0: the first real migration -------------------------------

/** Marker line that guards the `.noir/.env` pointer block in `config.yml`.
 *  Its presence means the block is already on disk — emitted by
 *  `config.yml.tmpl` for a new project, or appended by an earlier run of this
 *  migration — so the append is skipped. That guard is what makes the
 *  migration idempotent.
 *
 *  `config.yml.tmpl` carries the same literal (a template cannot import a
 *  TypeScript constant); `migration-1_0_0.test.ts` asserts the two agree so the
 *  guard cannot drift out from under the template. */
export const ENV_POINTER_MARKER = '# noir:env-pointer';

/** The comment block appended to an EXISTING `.noir/config.yml`. It states the
 *  two things a reader of that file needs: it is committable, and secrets go in
 *  `.noir/.env`. Deliberately comment-only — appending YAML keys would change
 *  the parsed config, which a migration must never do. */
const ENV_POINTER_BLOCK = [
  ENV_POINTER_MARKER,
  '# This file is safe to commit: it holds no secrets.',
  '# Project-scoped values and secrets belong in .noir/.env (gitignored, mode',
  '# 0600). .noir/.env.example documents the full variable set; `noir env`',
  '# reports which source wins for each key.',
  '',
].join('\n');

/** Append `block` to `prev` with exactly one blank line between the user's
 *  content and the block (no blank line at all when the file is empty). */
function appendSeparated(prev: string, block: string): string {
  if (prev.length === 0) return block;
  if (prev.endsWith('\n\n')) return `${prev}${block}`;
  return prev.endsWith('\n') ? `${prev}\n${block}` : `${prev}\n\n${block}`;
}

/** `1.0.0 → 1.1.0`: point an existing `.noir/config.yml` at `.noir/.env`.
 *
 *  Scoped to the one transformation `skipIfExists` structurally cannot perform.
 *  `config.yml` is a user-owned seed written once at init, so the manifest
 *  never opens an existing one — a project initialized before this migration
 *  existed would therefore never learn where secrets belong. Everything else
 *  this version adds is *creation* (a `skipIfExists` backfill) or *managed
 *  blocks* (`managedBlock` re-emission); the migration duplicates neither. */
const envPointer: MigrationScript = {
  from: '1.0.0',
  to: '1.1.0',
  description: 'point .noir/config.yml at .noir/.env (the secrets home)',
  run: (ctx) => {
    const result: MigrationResult = { changed: [], conflicts: [], notes: [] };
    const rel = '.noir/config.yml';
    const abs = join(ctx.root, '.noir', 'config.yml');

    // Absent: nothing to transform, and creating it is NOT this migration's
    // job — an absent `config.yml` is backfilled from the template (which
    // already carries the pointer) by the `skipIfExists` emit phase.
    if (!existsSync(abs)) {
      result.notes.push(`${rel}: absent — the template seed carries the pointer`);
      return result;
    }

    let prev: string;
    try {
      prev = readFileSync(abs, 'utf8');
    } catch (err) {
      // Unreadable (a directory, a permission wall). Non-throwing is the
      // registry-wide contract: record and let the caller decide.
      result.conflicts.push(rel);
      result.notes.push(`${rel}: unreadable (${errorMessage(err)}) — left untouched`);
      return result;
    }

    // The idempotency guard: a second run (or a file the template already
    // stamped) sees the marker and writes nothing at all — byte-level no-op.
    if (prev.includes(ENV_POINTER_MARKER)) {
      result.notes.push(`${rel}: already carries ${ENV_POINTER_MARKER}`);
      return result;
    }

    if (ctx.dryRun) {
      result.changed.push(rel);
      result.notes.push(`${rel}: would append the .noir/.env pointer`);
      return result;
    }

    try {
      writeFileSync(abs, appendSeparated(prev, ENV_POINTER_BLOCK), 'utf8');
    } catch (err) {
      result.conflicts.push(rel);
      result.notes.push(`${rel}: write failed (${errorMessage(err)}) — left untouched`);
      return result;
    }
    result.changed.push(rel);
    result.notes.push(`${rel}: appended the .noir/.env pointer`);
    return result;
  },
};

// --- 1.1.0 → 1.2.0: refresh the doc-only seeds ------------------------------

/** The doc-only seeds this migration walks. Each maps a repo-relative path to
 *  the seed kind it is recorded under and the template that renders its current
 *  bytes. Only these two are tracked: they are written once at init and never
 *  opened again by the manifest. `.env.example` changed in this release, so an
 *  unedited older copy must be brought forward. RULES.md is carried in the same
 *  loop although its text did NOT change here — its current render equals the
 *  recorded bytes, so the refresh decision leaves it alone today, and a future
 *  release that does change it is already handled. It is skipped entirely for a
 *  project that switched the working rules off; see {@link envTemplates}. */
const DOC_SEEDS: ReadonlyArray<{ rel: string; kind: SeedKind; template: string }> = [
  { rel: '.noir/.env.example', kind: 'envExample', template: 'env.example.tmpl' },
  { rel: '.noir/rules/RULES.md', kind: 'rulesSeed', template: 'rules-seed.md.tmpl' },
];

/** `1.1.0 → 1.2.0`: bring unedited doc seeds up to the text this build ships.
 *
 *  The decision is delegated to {@link isStaleSeed}, the same evidence the
 *  manifest uses: a file is refreshed only when its bytes are an exact match for
 *  a recorded past seed AND differ from the current render. A user-edited file
 *  (or one already current) is left alone. The write goes through
 *  {@link refreshSeed}, which overwrites the bytes while keeping the permission
 *  bits the file already has.
 *
 *  The working-rules seed is skipped outright when the project switched it off.
 *  That switch says this project has no working rules for Noir to maintain, and
 *  the refresh's evidence — "these bytes are a seed Noir shipped, so nobody
 *  edited them" — is exactly the case the switch must not act on: it would
 *  rewrite the rules text of a project that has opted out of having any, on the
 *  strength of a comparison the user never asked for. `.env.example` is a
 *  different file with a different owner (pure documentation, no switch), so it
 *  refreshes either way. */
const envTemplates: MigrationScript = {
  from: '1.1.0',
  to: '1.2.0',
  description: 'refresh the .env.example doc seed and keep RULES.md in step',
  run: (ctx) => {
    const result: MigrationResult = { changed: [], conflicts: [], notes: [] };
    for (const seed of DOC_SEEDS) {
      if (seed.kind === 'rulesSeed' && ctx.rulesEnabled === false) {
        result.notes.push(`${seed.rel}: skipped — the working-rules switch is off`);
        continue;
      }
      const abs = join(ctx.root, seed.rel);

      // Absent: nothing to refresh, and creating it is NOT this migration's
      // job — the upgrade's `skipIfExists` emit phase seeds it from the
      // template, which already carries the current text.
      if (!existsSync(abs)) {
        result.notes.push(`${seed.rel}: absent — nothing to refresh`);
        continue;
      }

      let prev: string;
      try {
        prev = readFileSync(abs, 'utf8');
      } catch (err) {
        // Unreadable (a directory, a permission wall). Non-throwing is the
        // registry-wide contract: record and let the caller decide.
        result.conflicts.push(seed.rel);
        result.notes.push(`${seed.rel}: unreadable (${errorMessage(err)}) — left untouched`);
        continue;
      }

      const current = render(loadTemplate(seed.template), {});
      if (!isStaleSeed(seed.kind, prev, current)) {
        result.notes.push(`${seed.rel}: user-owned or already current — left untouched`);
        continue;
      }

      if (ctx.dryRun) {
        result.changed.push(seed.rel);
        result.notes.push(`${seed.rel}: would refresh to the current seed`);
        continue;
      }

      try {
        refreshSeed(abs, current);
      } catch (err) {
        result.conflicts.push(seed.rel);
        result.notes.push(`${seed.rel}: refresh failed (${errorMessage(err)}) — left untouched`);
        continue;
      }
      result.changed.push(seed.rel);
      result.notes.push(`${seed.rel}: refreshed to the current seed`);
    }
    return result;
  },
};

// --- 1.2.0 → 1.3.0: put a joined repo's MCP entry back on the bridge -------

/** Where this repo's host keeps its MCP config, repo-relative and POSIX, or
 *  `null` when the file is not there. The host is read from `.noir/config.yml`
 *  exactly as the scaffold reads it; an absent or unreadable config means the
 *  default host (`claude`, whose config is the root `.mcp.json`). */
function mcpConfigPath(root: string): { rel: string; abs: string } | null {
  let host: HostId = 'claude';
  try {
    host = loadProjectInfo(root).config.host;
  } catch {
    // No readable project id/config — fall back to the default host rather than
    // failing the migration. Its config path is the one the older join flow used.
  }
  const abs = mcpConfigPathFor(host, root);
  if (!existsSync(abs)) return null;
  return { rel: relative(root, abs).split(sep).join('/'), abs };
}

/** `1.2.0 → 1.3.0`: rewrite the stale `http://…/mcp?p=<projectId>` pointer that
 *  a repo which joined a workspace under the older flow still carries.
 *
 *  That entry named a daemon by address, which cannot survive a restart: the
 *  workspace daemon binds an ephemeral port and mints a fresh token every start,
 *  while the config was written once, at join time. The current flow writes a
 *  stdio entry naming the workspace instead, so the host reaches the daemon
 *  through the bridge, which resolves the address and reads the token itself.
 *
 *  No other command can repair this. `sync` re-emits the entry from the manifest
 *  (so a re-scaffold keeps a joined repo joined) but leaves a file that differs
 *  from the template alone unless it is forced, and the project's own
 *  `.mcp.json` is not otherwise opened. The upgrade path is where a repair that
 *  no emit can express belongs.
 *
 *  Two conditions gate the rewrite, and both matter. The repo must carry the
 *  workspace marker — a repo that deliberately chose the http transport has an
 *  http entry too, and rewriting it would be wrong. And the entry must not
 *  already be on the bridge: a joined repo whose entry names the workspace needs
 *  nothing, which is what makes a second run a byte-level no-op.
 *
 *  "Not on the bridge" is deliberately wider than "is the http pointer". The
 *  same downgrade appears in a second shape: a joined repo whose `noir` entry is
 *  the plain repo-scoped stdio form (`command`/`args` with no `--workspace`),
 *  which is what a re-scaffold under an earlier release rewrote a joined repo's
 *  entry to — the marker and the config then disagree about the same repo. A
 *  marker is proof of membership, so an entry that does not name the workspace
 *  is stale whichever form it is in, and both are repaired here. An entry in
 *  neither shape (no `command`, no `type: 'http'`) is left alone: it is not a
 *  transport this migration owns. */
const workspaceBridge: MigrationScript = {
  from: '1.2.0',
  to: '1.3.0',
  description: "point a joined repo's MCP entry at the workspace bridge",
  run: (ctx) => {
    const result: MigrationResult = { changed: [], conflicts: [], notes: [] };
    const name = readWorkspaceMarker(ctx.root);
    if (name === null) {
      result.notes.push('not joined to a workspace — nothing to rewrite');
      return result;
    }
    const target = mcpConfigPath(ctx.root);
    if (target === null) {
      result.notes.push(`workspace "${name}": no MCP config file to migrate`);
      return result;
    }

    let config: Record<string, unknown>;
    try {
      config = JSON.parse(readFileSync(target.abs, 'utf8')) as Record<string, unknown>;
    } catch (err) {
      // Unparseable (JSONC, a trailing comma, a directory). Non-throwing is the
      // registry-wide contract: record and let the caller decide.
      result.conflicts.push(target.rel);
      result.notes.push(`${target.rel}: unreadable (${errorMessage(err)}) — left untouched`);
      return result;
    }

    const servers = config.mcpServers;
    if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) {
      result.notes.push(`${target.rel}: no mcpServers block — left untouched`);
      return result;
    }
    const entry = (servers as Record<string, unknown>).noir;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      result.notes.push(`${target.rel}: no noir entry — left untouched`);
      return result;
    }
    // Which stale shape is this entry in? An http pointer names a daemon by
    // address. A stdio entry that does NOT pass `--workspace` is the repo-scoped
    // form — the downgrade a re-scaffold used to apply to a joined repo. An
    // entry that already names the workspace is the bridge entry a fresh join
    // writes, so there is nothing to repair (and a second run stays a no-op).
    const entryObj = entry as Record<string, unknown>;
    const args = entryObj.args;
    const namesWorkspace = Array.isArray(args) && args.includes('--workspace');
    const isHttpPointer = entryObj.type === 'http';
    const isRepoScopedStdio = typeof entryObj.command === 'string' && !namesWorkspace;
    if (!isHttpPointer && !isRepoScopedStdio) {
      result.notes.push(
        namesWorkspace
          ? `${target.rel}: already reaches Noir over the bridge — left untouched`
          : `${target.rel}: noir entry is not a transport this migration owns — left untouched`,
      );
      return result;
    }
    const kept = Object.entries(entryObj).filter(([key]) => !TRANSPORT_KEYS.has(key));

    if (ctx.dryRun) {
      result.changed.push(target.rel);
      result.notes.push(`${target.rel}: would point the noir entry at workspace "${name}"`);
      return result;
    }

    const next = {
      ...config,
      mcpServers: {
        ...(servers as Record<string, unknown>),
        noir: {
          command: resolveNoirCommand(),
          // The argv comes from the adapters' own helper, so this rewrite lands
          // on exactly the entry a fresh join writes — the name is the whole
          // address, and the bridge resolves the daemon (and reads its token)
          // itself, so none of that is written into a committed config file.
          args: noirStdioArgs(name),
          ...Object.fromEntries(kept),
        },
      },
    };
    try {
      atomicWriteFile(target.abs, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      result.conflicts.push(target.rel);
      result.notes.push(`${target.rel}: write failed (${errorMessage(err)}) — left untouched`);
      return result;
    }
    result.changed.push(target.rel);
    result.notes.push(`${target.rel}: noir entry now reaches workspace "${name}" over the bridge`);
    return result;
  },
};

/** The registry. The runner sorts the selected window by `to`, so declaration
 *  order is documentation only — oldest step first. */
export const MIGRATIONS: readonly MigrationScript[] = [
  synthetic,
  envPointer,
  envTemplates,
  workspaceBridge,
];
/** `Error.message` for anything thrown, without assuming an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- conflict-marker helpers (exported for migration authors) ---------------

/** Write git-style inline conflict markers around `theirs`/`ours` so a human
 *  or AI agent can resolve later. This is the CI-safe fallback —
 *  no interactive prompts, ever. */
export function applyInlineConflict(
  ours: string,
  theirs: string,
  oursLabel = 'ours',
  theirsLabel = 'theirs',
): string {
  return `<<<<<<< ${oursLabel}\n${ours}=======\n${theirs}>>>>>>> ${theirsLabel}\n`;
}

/** Apply `(ours, theirs)` to a region: if they're equal, return `ours` (no
 *  conflict); otherwise emit inline markers. Migration authors should prefer
 *  this over {@link applyInlineConflict} when the "no change needed" case is
 *  common — it keeps re-runs truly idempotent (no spurious markers on a clean
 *  tree). */
export function applyWithConflict(
  ours: string,
  theirs: string,
  path: string,
): {
  text: string;
  conflicted: boolean;
} {
  if (ours === theirs) return { text: ours, conflicted: false };
  return {
    text: applyInlineConflict(ours, theirs, path, path),
    conflicted: true,
  };
}
