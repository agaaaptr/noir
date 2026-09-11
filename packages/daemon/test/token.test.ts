// Daemon HTTP-transport token (spec 6.1): one 0600 secret per daemon identity,
// regenerated on every start. The file is a credential the moment it exists, so
// the mode is asserted here and the HTTP enforcement is asserted in http.test.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const tmpRoot = mkdtempSync(join(tmpdir(), 'noir-token-'));
process.env.NOIR_DAEMON_DIR = tmpRoot;

const {
  clearDaemonToken,
  generateToken,
  readDaemonToken,
  scopeKeyForProject,
  tokenMatches,
  tokenPath,
  writeDaemonToken,
} = await import('../src/token.js');

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('daemon token', () => {
  it('writes a token and reads it back', () => {
    writeDaemonToken('proj-x', 'abc123');
    expect(readDaemonToken('proj-x')).toBe('abc123');
    expect(existsSync(join(tmpRoot, 'proj-x.token'))).toBe(true);
  });

  // `mode` on writeFileSync is a no-op on Windows (permissions are ACL-based),
  // so a POSIX-mode assertion is only meaningful elsewhere.
  it.skipIf(process.platform === 'win32')('stores the token file as 0600', () => {
    writeDaemonToken('proj-mode', 'abc123');
    expect(statSync(join(tmpRoot, 'proj-mode.token')).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'keeps 0600 across a rewrite of the same scope key',
    () => {
      writeDaemonToken('proj-rewrite', 'first');
      writeDaemonToken('proj-rewrite', 'second');
      expect(readDaemonToken('proj-rewrite')).toBe('second');
      expect(statSync(join(tmpRoot, 'proj-rewrite.token')).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'applies 0600 even under a fully permissive umask',
    () => {
      const prev = process.umask(0o000);
      try {
        // Control: under this umask an ordinary write lands 0666, so the token
        // assertion below can only pass because `mode` reached writeFileSync —
        // not because the runner's umask happened to be restrictive.
        writeFileSync(join(tmpRoot, 'umask-control'), 'x');
        expect(statSync(join(tmpRoot, 'umask-control')).mode & 0o777).toBe(0o666);
        writeDaemonToken('proj-umask', 'abc123');
        expect(statSync(join(tmpRoot, 'proj-umask.token')).mode & 0o777).toBe(0o600);
      } finally {
        process.umask(prev);
      }
    },
  );

  it('reads null for an absent, empty, or whitespace-only file', () => {
    expect(readDaemonToken('never-written')).toBeNull();
    writeFileSync(tokenPath('proj-empty'), '', 'utf8');
    expect(readDaemonToken('proj-empty')).toBeNull();
    writeFileSync(tokenPath('proj-blank'), '  \n', 'utf8');
    expect(readDaemonToken('proj-blank')).toBeNull();
  });

  it('clearDaemonToken removes the file and is idempotent', () => {
    writeDaemonToken('proj-clear', 'abc123');
    clearDaemonToken('proj-clear');
    expect(existsSync(tokenPath('proj-clear'))).toBe(false);
    expect(readDaemonToken('proj-clear')).toBeNull();
    expect(() => clearDaemonToken('proj-clear')).not.toThrow();
  });

  it('the scope key for a project daemon is its projectId', () => {
    expect(scopeKeyForProject('deadbeef')).toBe('deadbeef');
    expect(tokenPath(scopeKeyForProject('deadbeef'))).toBe(join(tmpRoot, 'deadbeef.token'));
  });

  it('writes exactly one token per file, newline-terminated', () => {
    writeDaemonToken('proj-file', 'abc123');
    expect(readFileSync(join(tmpRoot, 'proj-file.token'), 'utf8')).toBe('abc123\n');
  });

  it('generates a fresh token per write', () => {
    expect(generateToken()).not.toBe(generateToken());
    expect(generateToken().length).toBeGreaterThanOrEqual(32);
  });

  it('tokenMatches compares exactly, rejecting absent/short/long/wrong values', () => {
    const token = 'abc123';
    expect(tokenMatches(token, 'abc123')).toBe(true);
    expect(tokenMatches(token, 'abc124')).toBe(false);
    expect(tokenMatches(token, 'abc12')).toBe(false);
    expect(tokenMatches(token, 'abc1234')).toBe(false);
    expect(tokenMatches(token, '')).toBe(false);
    expect(tokenMatches(token, undefined)).toBe(false);
  });
});
