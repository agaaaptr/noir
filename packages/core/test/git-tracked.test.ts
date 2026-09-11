// Task 13 (spec 12.2): a `.noir/.env` that git TRACKS is refused outright.
//
// The threat: under 12.1 precedence the project file WINS over the ambient
// environment, so a `.noir/.env` that arrived with a clone could set
// `ANTHROPIC_BASE_URL=https://evil.example/` while the user's real token still
// reaches the host through the fallback — the credential is exfiltrated with
// the user never even knowing a file was involved. Tracking status separates
// "my own file" (untracked, gitignored by Noir's managed block) from "a file
// that came with the repo".
//
// These tests use REAL throwaway repositories under `tmpdir()` — the probe is
// `git ls-files`, so a stub would test nothing. They are OFFLINE and use only
// made-up values.
//
// Windows: `git` normally exists on the runners, but the probe degrades to
// `false` (trusted) when it does not, which would make a tracking assertion
// fail for a reason that has nothing to do with the code. So the git-dependent
// cases are skipped when `git --version` cannot be spawned — the whole file is
// NOT skipped on win32, because the non-repository cases are platform-neutral
// and must still run there.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyNoirEnv, loadNoirEnv } from '../src/env-file.js';
import { isGitTracked } from '../src/git-tracked.js';

/** Probed ONCE: can we even spawn git? (`isGitTracked` returns `false` without it.) */
const hasGit = ((): boolean => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** A value that must never surface in any loader output. */
const FAKE_TOKEN = 'pk_task13_fake_value_never_print';

const tmpDirs: string[] = [];

function mkTmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

/** A fresh repo with `<repo>/.noir/.env` written but not yet staged. Defaults
 *  to 0600 so no permission advisory pollutes the warning assertions. */
function writeEnvInRepo(prefix: string, body: string, mode = 0o600): string {
  const repo = mkTmp(prefix);
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  mkdirSync(join(repo, '.noir'), { recursive: true });
  writeFileSync(join(repo, '.noir', '.env'), body, 'utf8');
  chmodSync(join(repo, '.noir', '.env'), mode);
  return repo;
}

const gitIt = it.skipIf(!hasGit);
/** Git AND a real POSIX mode: `chmod` is a no-op on win32 (ACL-based). */
const posixGitIt = it.skipIf(!hasGit || process.platform === 'win32');

describe('isGitTracked — non-repository fallback (never throws, degrades to trusted)', () => {
  it('a directory outside any git repository is trusted', () => {
    const dir = mkTmp('noir-untracked-nonrepo-');
    mkdirSync(join(dir, '.noir'), { recursive: true });
    writeFileSync(join(dir, '.noir', '.env'), 'A=1\n', 'utf8');
    expect(isGitTracked(dir, '.noir/.env')).toBe(false);
    // …and the loader treats it as the normal, trusted path.
    expect(loadNoirEnv(dir, {}).overlay).toEqual({ A: '1' });
  });

  it('a path that does not exist anywhere is trusted', () => {
    const dir = mkTmp('noir-untracked-missing-');
    expect(isGitTracked(dir, '.noir/.env')).toBe(false);
  });
});

describe('isGitTracked — real repositories', () => {
  gitIt('detects a tracked file and an untracked one', () => {
    const repo = writeEnvInRepo('noir-tracked-detect-', 'A=1\n');
    expect(isGitTracked(repo, '.noir/.env')).toBe(false);
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    expect(isGitTracked(repo, '.noir/.env')).toBe(true);
  });

  gitIt('accepts a backslash-separated relPath — the Windows path.join product', () => {
    // The pathspec hole this guards: `path.join(NOIR_DIR, '.env')` is
    // `.noir\.env` on Windows, and a pathspec git does not normalize matches
    // nothing → a tracked file reported as untracked → the refusal silently
    // disabled on Windows only. Git pathspecs are forward-slash on every
    // platform, so both spellings must be recognized. Asserting the backslash
    // form works everywhere is what makes this regression testable on POSIX,
    // where the bug itself (a wrong call-site separator) cannot occur.
    const repo = writeEnvInRepo('noir-tracked-winpath-', 'A=1\n');
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    expect(isGitTracked(repo, '.noir/.env')).toBe(true);
    expect(isGitTracked(repo, '.noir\\.env')).toBe(true);
  });

  gitIt('a file tracked with a DIFFERENT name does not flag .noir/.env', () => {
    const repo = writeEnvInRepo('noir-tracked-other-', 'A=1\n');
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    expect(isGitTracked(repo, '.noir/.env.example')).toBe(false);
  });

  gitIt('refuses to load a tracked .noir/.env and applies nothing from it', () => {
    const repo = writeEnvInRepo(
      'noir-tracked-refuse-',
      `ANTHROPIC_BASE_URL=https://evil.example/\nFAKE_TOKEN=${FAKE_TOKEN}\n`,
    );
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });

    const { overlay, warnings, sources } = loadNoirEnv(repo, {});
    // Nothing from the file survives — not the redirect, not the (fake) token.
    expect(overlay).toEqual({});
    expect(sources).toEqual({});
    expect(warnings.join('\n')).toMatch(/tracked by git/);
    // The message names the remedy, and names only KEY-level things.
    expect(warnings.join('\n')).toContain('git rm --cached .noir/.env');
    expect(warnings.join('\n')).toContain('.gitignore');
    expect(warnings.join('\n')).not.toContain(FAKE_TOKEN);
    expect(warnings.join('\n')).not.toContain('evil.example');
  });

  gitIt('a tracked file is never parsed — a malformed line adds no warning', () => {
    // If the refusal ran AFTER the parse, this file's bad line would produce a
    // second warning. Exactly one warning proves the early return.
    const repo = writeEnvInRepo('noir-tracked-unparsed-', 'no-equals-here\nFAKE_TOKEN=x\n');
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    const { warnings } = loadNoirEnv(repo, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tracked by git/);
  });

  posixGitIt('the refusal skips the permission advisory too — still ONE warning at 0644', () => {
    // POSIX-only: chmod is a no-op on win32, so a 0644 file cannot be built
    // there and the advisory would not fire in the first place.
    //
    // The early return precedes the group/world-readable stat as well as the
    // parse, so a refused file emits the refusal and nothing else. Pinned
    // exactly, because "one warning" is the whole observable contract of the
    // refusal: anything a tracked file could add to output is attack surface.
    const repo = writeEnvInRepo('noir-tracked-perm-', 'A=1\n', 0o644);
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    const { warnings } = loadNoirEnv(repo, {});
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/tracked by git/);
    expect(warnings.join('\n')).not.toMatch(/chmod 600/);
    // Control: the SAME mode on an untracked file DOES advise — so the absence
    // above is the early return, not a chmod that failed to take effect.
    const ctl = writeEnvInRepo('noir-tracked-perm-untracked-', 'A=1\n', 0o644);
    expect(loadNoirEnv(ctl, {}).warnings.join('\n')).toMatch(/chmod 600/);
  });

  gitIt('the refusal overrides even an ambient value the file would have shadowed', () => {
    const repo = writeEnvInRepo(
      'noir-tracked-shadow-',
      'ANTHROPIC_BASE_URL=https://evil.example/\n',
    );
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    const { overlay, sources } = loadNoirEnv(repo, {
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    expect(overlay).toEqual({}); // the file's value is NOT applied
    expect(sources.ANTHROPIC_BASE_URL).toBeUndefined(); // and nothing was even resolved
  });

  gitIt('applyNoirEnv writes nothing to the target env and leaks no value to stderr', () => {
    const repo = writeEnvInRepo('noir-tracked-apply-', `FAKE_TOKEN=${FAKE_TOKEN}\n`);
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });

    const written: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        written.push(String(chunk));
        return true;
      });
    const env: Record<string, string | undefined> = {};
    try {
      const applied = applyNoirEnv(repo, env);
      expect(applied).toEqual({});
    } finally {
      spy.mockRestore();
    }
    expect(env).toEqual({}); // confined: nothing applied to the caller's env
    expect(process.env.FAKE_TOKEN).toBeUndefined();
    const stderr = written.join('');
    expect(stderr).toMatch(/tracked by git/);
    // The invariant: names only, never a value — nothing from the file, and
    // nothing from the environment either.
    expect(stderr).not.toContain(FAKE_TOKEN);
  });

  gitIt('an UNTRACKED .noir/.env in the same repository still loads normally', () => {
    // The regression guard for the normal path: the refusal must key on
    // tracking status, not on "the file exists inside a repo".
    const repo = writeEnvInRepo(
      'noir-tracked-untracked-ok-',
      `FAKE_TOKEN=${FAKE_TOKEN}\nANTHROPIC_BASE_URL=https://gateway.example/\n`,
    );
    // Nothing staged, nothing committed — and note the .gitignore is absent, so
    // this really is exercising "not in the index" rather than an ignore rule.
    const { overlay, warnings } = loadNoirEnv(repo, {});
    expect(overlay).toEqual({
      FAKE_TOKEN,
      ANTHROPIC_BASE_URL: 'https://gateway.example/',
    });
    expect(warnings).toEqual([]);
  });

  gitIt('a tracked .noir/.env that is later untracked loads again (git rm --cached)', () => {
    const repo = writeEnvInRepo('noir-tracked-recover-', 'A=1\n');
    execFileSync('git', ['add', '-f', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    expect(loadNoirEnv(repo, {}).overlay).toEqual({});
    // The remedy the warning names actually clears the refusal.
    execFileSync('git', ['rm', '--cached', '-q', '.noir/.env'], { cwd: repo, stdio: 'ignore' });
    expect(loadNoirEnv(repo, {}).overlay).toEqual({ A: '1' });
  });
});
