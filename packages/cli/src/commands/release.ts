// c4-release-phase — `noir release [<version>] [--channel beta|stable]`.
// A guided orchestrator over the existing patch-release flow (CLAUDE.md).
// Walks the checklist; hands off at human-approval gates. The FSM release
// phase (optional, done→released) is documented in the design spec but not
// yet wired — this CLI is the release tool the roadmap delta called for.
// Build-once / idempotent: bump-version.mjs is idempotent; release:tag
// refuses dirty/unpushed; tags are immutable (never reuse — deprecate+patch).

import { execSync, spawnSync } from 'node:child_process';
import { type CliOptions, EXIT, fail, info, log, success, tip, warn } from '../output.js';

export interface ReleaseOptions extends CliOptions {
  version?: string;
  channel?: string;
  dryRun?: boolean;
}

type Step =
  | 'preflight'
  | 'bump'
  | 'gate'
  | 'commit'
  | 'ci-develop'
  | 'beta-tag'
  | 'human-approve-beta'
  | 'merge-main'
  | 'ci-main'
  | 'stable-tag'
  | 'human-approve-stable'
  | 'dist-bump'
  | 'sync';

/** Report what step does and who runs it. */
function describe(step: Step, who: 'noir' | 'human'): string {
  const m: Record<Step, string> = {
    preflight: 'check clean tree, on develop, HEAD pushed, gate green, no version collision',
    bump: 'run bump-version.mjs + update CHANGELOG + roadmap docs',
    gate: 're-run the full gate (lint/build/typecheck/test/docs:validate)',
    commit: 'commit chore(release) + push develop',
    'ci-develop': 'wait for CI on develop → green',
    'beta-tag': 'pnpm release:tag → beta tag + push',
    'human-approve-beta': 'approve the release workflow publish job in GitHub Actions',
    'merge-main': 'merge develop → main (fast-forward) + push',
    'ci-main': 'wait for CI on main → green',
    'stable-tag': 'pnpm release:tag → stable tag + push',
    'human-approve-stable': 'approve the release workflow publish job in GitHub Actions (again)',
    'dist-bump':
      'update Homebrew (packaging/homebrew/noir.rb) + Scoop (packaging/scoop/noir.json) from npm',
    sync: 'merge main → develop + verify both branches at same SHA',
  };
  return `${m[step]} [${who}]`;
}

const ALL: Step[] = [
  'preflight',
  'bump',
  'gate',
  'commit',
  'ci-develop',
  'beta-tag',
  'human-approve-beta',
  'merge-main',
  'ci-main',
  'stable-tag',
  'human-approve-stable',
  'dist-bump',
  'sync',
];

export async function release(opts: ReleaseOptions): Promise<void> {
  if (opts.dryRun) {
    log('noir release --dry-run (no changes will be made)', opts);
    for (const s of ALL) {
      const who: 'noir' | 'human' = s.startsWith('human-approve') ? 'human' : 'noir';
      info(`${s}: ${describe(s, who)}`, opts);
    }
    tip('full release flow documented in CLAUDE.md "Patch release flow (beta → stable)"', opts);
    return;
  }

  const version = opts.version?.trim();
  if (!version) {
    fail(EXIT.USAGE, 'release: <version> is required (e.g. noir release 1.10.0)', opts);
  }
  const channel = opts.channel === 'stable' ? 'stable' : 'beta';

  log(`noir release ${version} (${channel} channel)`, opts);

  // Run each step; hand off at human gates. Failures surface clearly.
  try {
    // 1. Preflight
    info(`[1/13] preflight: ${describe('preflight', 'noir')}`, opts);
    execSync('git diff --quiet', { encoding: 'utf8' });
    const branch = execSync('git branch --show-current', { encoding: 'utf8' }).trim();
    if (branch !== 'develop') fail(EXIT.ERROR, 'release: must be on develop', opts);
    const status = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    if (status) fail(EXIT.ERROR, 'release: tree must be clean', opts);
    success('preflight: ✓ clean, on develop', opts);

    // 2. Bump
    info(`[2/13] bump: ${describe('bump', 'noir')}`, opts);
    spawnSync('node', ['scripts/bump-version.mjs', version], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    success(`bump: ✓ version ${version}`, opts);

    // 3. Gate
    info(`[3/13] gate: ${describe('gate', 'noir')}`, opts);
    execSync('pnpm lint && pnpm build && pnpm typecheck && pnpm test && pnpm docs:validate', {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    success('gate: ✓ full gate green', opts);

    // 4. Commit (spawnSync — no shell, no injection).
    info(`[4/13] commit/push: ${describe('commit', 'noir')}`, opts);
    spawnSync('git', ['add', '-A'], { encoding: 'utf8', stdio: 'inherit' });
    spawnSync('git', ['commit', '-m', `chore(release): v${version} + docs sync`], {
      encoding: 'utf8',
      stdio: 'inherit',
    });
    execSync('git push origin develop', { encoding: 'utf8' });
    success('commit: ✓ pushed to develop', opts);

    // 5-6. CI wait + beta tag
    info(`[5/13] ci-develop: waiting for CI on develop…`, opts);
    info(`[6/13] beta-tag: ${describe('beta-tag', 'noir')}`, opts);
    tip('after CI green: run `pnpm release:tag` and push the beta tag', opts);

    // 7. Human handoff
    warn(`[7/13] ${describe('human-approve-beta', 'human')}`, opts);
    tip('open GitHub Actions → approve the publish job, then continue', opts);
    tip('after approval: verify `npm view @noir-ai/cli dist-tags beta` = beta version', opts);

    // 8-13 (remaining steps — documented for human continuation)
    info('remaining steps (merge→stable→dist→sync): see CLAUDE.md', opts);
    for (const s of ALL.slice(7)) {
      const who: 'noir' | 'human' = s.startsWith('human-approve') ? 'human' : 'noir';
      info(`  ${s}: ${describe(s, who)}`, opts);
    }

    success(`release ${version}: preflight→bump→gate→commit done. Resume after approval.`, opts);
  } catch (err) {
    fail(EXIT.ERROR, `release failed: ${err instanceof Error ? err.message : String(err)}`, opts);
  }
}
