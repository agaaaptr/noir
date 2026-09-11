/**
 * Migration model — Nx-style declarative upgrade scripts, hand-rolled.
 *
 * Per the Slice S design (S-OQ2 resolved → inline conflict markers, never
 * interactive prompts), every migration script:
 *  - is a small, IDEMPOTENT TypeScript function (`run(root, opts) → result`).
 *    Re-running it on an already-migrated tree is a no-op (or produces the
 *    same conflict markers again — also safe).
 *  - NEVER prompts. `--no-input` CI must survive. When a migration cannot
 *    reconcile a co-edited region, it writes git-style conflict markers
 *    (`<<<<<<<` / `=======` / `>>>>>>>`) into the file and records the path in
 *    `result.conflicts` so the caller (doctor/CI) can fail loudly with a
 *    reviewable artifact rather than hang on a prompt.
 *
 * The registry ({@link MIGRATIONS}) carries two entries: the synthetic
 * `1.0.0 → 1.0.0` smoke test that exercises the runner end-to-end, and the
 * first real version-to-version migration, `1.0.0 → 1.1.0`. The synthetic one
 * is the copy-pasteable template for the next contributor.
 */

export interface MigrationContext {
  /** Absolute repo root the migration operates on. */
  root: string;
  /** When true, the runner performs all reads and the would-be writes, returns
   *  the same `changed`/`conflicts` shape, but does NOT touch disk. Used by
   *  `noir doctor`/CI to preview. */
  dryRun?: boolean;
}

export interface MigrationResult {
  /** Repo-relative paths the migration modified (or would modify, in dryRun). */
  changed: string[];
  /** Repo-relative paths left with inline conflict markers. Always non-throwing. */
  conflicts: string[];
  /** Free-form notes for doctor/CI logs (e.g. "rewrote CLAUDE.md import"). */
  notes: string[];
}

/** A single version-to-version step. `from`/`to` are inclusive endpoints on a
 *  linear history; the runner composes a chain by matching `from` of the next
 *  script to `to` of the previous. */
export interface MigrationScript {
  from: string;
  to: string;
  description: string;
  run: (ctx: MigrationContext) => MigrationResult;
}
