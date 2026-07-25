import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationResult, MigrationScript } from './types.js';

export { runMigrations } from './runner.js';
export type { MigrationContext, MigrationResult, MigrationScript } from './types.js';

/**
 * Migration registry — the linear history of scaffold-version upgrades.
 *
 * At v1.0.0 there are no real migrations (the package ships fresh, so every
 * install starts at `CURRENT_SCAFFOLD_VERSION`). The registry is the
 * deliverable: it proves the runner end-to-end and gives the next contributor
 * a copy-pasteable template. Add the first real entry here when a template or
 * manifest change merits a `1.0.0 → 1.1.0` step.
 *
 * Convention:
 *  - `from`/`to` are bare `x.y.z` (no `v` prefix, no pre-release); the runner
 *    compares them numerically.
 *  - Every `run` MUST be idempotent and non-throwing (capture failures into
 *    `result.conflicts`). See {@link types.ts}.
 *  - Conflict resolution writes git-style markers inline — see
 *    {@link applyWithConflict} for the canonical helper.
 */

/** Synthetic 1.0.0 → 1.0.0 migration. Proves the runner wires up; also
 *  demonstrates the conflict-marker path with a guarded, idempotent touch on
 *  `.noir/scaffold-version` only when explicitly asked via
 *  `NOIR_TEST_FORCE_CONFLICT`. Safe to remove once a real migration lands. */
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

export const MIGRATIONS: readonly MigrationScript[] = [synthetic];

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
