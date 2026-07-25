import { MIGRATIONS } from './index.js';
import type { MigrationContext, MigrationResult, MigrationScript } from './types.js';

/**
 * Migration runner. Given a `from` version present on disk and a target `to`
 * version (usually {@link CURRENT_SCAFFOLD_VERSION}), walks the
 * {@link MIGRATIONS} registry forward in version order, executing each step.
 *
 * Selection rule: a script runs when its `from` is `>= fromArg` (semver-ish
 * string compare is enough at Noir's scale; we don't pull in a semver dep for
 * this) AND its `to` is `<= toArg`. Scripts strictly outside the window are
 * skipped. Within the window, scripts run sorted by `to` ascending so a
 * multi-step upgrade (1.0.0 → 1.1.0 → 1.2.0) composes in order.
 *
 * The runner NEVER throws on a per-script failure — it captures the error,
 * records a synthetic conflict entry (`<path>__error`), and continues so a
 * single broken migration doesn't block the rest of the chain. The orchestrator
 * decides whether non-empty `conflicts` is a hard failure (init --upgrade) or a
 * warning (doctor).
 *
 * Returns the aggregate of every step's `changed`/`conflicts`/`notes`.
 */
export function runMigrations(
  root: string,
  from: string | null,
  to: string,
  opts: { dryRun?: boolean } = {},
): MigrationResult & { from: string | null; to: string; ran: string[] } {
  const window = pickWindow(from ?? '0.0.0', to, MIGRATIONS);
  const ctx: MigrationContext = { root, dryRun: opts.dryRun === true };
  const aggregate: MigrationResult = { changed: [], conflicts: [], notes: [] };
  const ran: string[] = [];

  for (const script of window) {
    ran.push(`${script.from}→${script.to}`);
    let res: MigrationResult;
    try {
      res = script.run(ctx);
    } catch (err) {
      // Non-fatal at the runner level: record and continue. The caller turns
      // non-empty conflicts into a CI failure with a real exit code.
      const msg = err instanceof Error ? err.message : String(err);
      aggregate.conflicts.push(`<runner>:${script.from}→${script.to} threw: ${msg}`);
      continue;
    }
    aggregate.changed.push(...res.changed);
    aggregate.conflicts.push(...res.conflicts);
    aggregate.notes.push(...res.notes);
  }

  return {
    ...aggregate,
    from,
    to,
    ran,
  };
}

/** Pick the ordered subset of `scripts` forming the chain `[from, to]`. */
function pickWindow(
  from: string,
  to: string,
  scripts: readonly MigrationScript[],
): MigrationScript[] {
  return scripts
    .filter((s) => compareVer(s.from) >= compareVer(from) && compareVer(s.to) <= compareVer(to))
    .sort((a, b) => compareVer(a.to) - compareVer(b.to));
}

/** Tiny numeric tuple compare: `'1.10.3'` → `[1,10,3]`, compared element-wise.
 *  Pre-release suffixes (e.g. `-beta.1`) are ignored — Noir ships `x.y.z`
 *  scaffold versions and the runner only needs a deterministic order. */
function compareVer(v: string): number {
  const parts = v.split('-')[0]?.split('.') ?? [];
  let n = 0;
  for (let i = 0; i < 3; i++) {
    const p = Number(parts[i] ?? '0');
    n = n * 1000 + (Number.isFinite(p) ? p : 0);
  }
  return n;
}
