import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationResult, MigrationScript } from './types.js';

export { runMigrations } from './runner.js';
export type { MigrationContext, MigrationResult, MigrationScript } from './types.js';

/**
 * Migration registry — the linear history of scaffold-version upgrades.
 *
 * `CURRENT_SCAFFOLD_VERSION` is `1.1.0`; a project stamped at an older version
 * migrates through every entry whose window covers it. Two entries ship today:
 * the synthetic `1.0.0 → 1.0.0` runner-proof, and the first REAL migration,
 * `1.0.0 → 1.1.0`, which performs the transformation `skipIfExists` cannot.
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

// --- 1.0.0 → 1.1.0: the first real migration (spec §11.2) --------------------

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
 *  never opens an existing one — a project initialized before this slice would
 *  therefore never learn where secrets belong. Everything else this slice adds
 *  is *creation* (§11.1's `skipIfExists` backfill) or *managed blocks*
 *  (`managedBlock` re-emission); the migration duplicates neither. */
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

/** The registry. The runner sorts the selected window by `to`, so declaration
 *  order is documentation only — oldest step first. */
export const MIGRATIONS: readonly MigrationScript[] = [synthetic, envPointer];

/** `Error.message` for anything thrown, without assuming an Error. */
function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- conflict-marker helpers (exported for migration authors) ---------------

/** Write git-style inline conflict markers around `theirs`/`ours` so a human
 *  or AI agent can resolve later. This is the CI-safe fallback the spec locks
 *  in (S-OQ2) — no interactive prompts, ever. */
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
