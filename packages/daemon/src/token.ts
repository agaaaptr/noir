// Shared secret between a daemon and its clients. Regenerated on every daemon
// start, so a token never outlives the process that issued it. 0600 because the
// file is a credential the moment it exists (spec 6.1).
//
// Scope key: one token file per daemon identity, next to that identity's record
// in `projectRecordDir()` — a project daemon's key is its projectId (Task 6
// mirrors this for a workspace daemon, whose key is the workspace name). The
// stdio transport never reads or writes a token: it has no network surface, and
// the host header-forwarding bugs make a header-delivered token unsafe there.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '@noir-ai/core';
import { projectRecordDir } from './project-record.js';

/** 32 bytes → 43 base64url chars. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The token scope key for a per-project daemon is its projectId — the same
 * identity keying that project's daemon record, so `"<scopeKey>.token"` and
 * `"<scopeKey>.json"` always describe the same daemon.
 */
export function scopeKeyForProject(projectId: string): string {
  return projectId;
}

export function tokenPath(scopeKey: string): string {
  return join(projectRecordDir(), `${scopeKey}.token`);
}

export function writeDaemonToken(scopeKey: string, token: string): void {
  atomicWriteFile(tokenPath(scopeKey), `${token}\n`, { mode: 0o600 });
}

export function readDaemonToken(scopeKey: string): string | null {
  const path = tokenPath(scopeKey);
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch (err) {
    // ENOENT means the file is genuinely absent — the common "no token yet"
    // case (a stdio-only daemon, or one that never minted a token) and a
    // completely normal null. Any OTHER error (EACCES, EIO, EISDIR…) means the
    // file is there but unreadable: surface it once, naming the file and the
    // error CODE only (never the token value), so a permissions problem does
    // not masquerade as "no token" and send the user after the wrong remedy.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    process.stderr.write(
      `noir: warning: cannot read the daemon token file at ${path} ` +
        `(${(err as NodeJS.ErrnoException).code ?? 'UNKNOWN'}) — proceeding without a token\n`,
    );
    return null;
  }
}

export function clearDaemonToken(scopeKey: string): void {
  rmSync(tokenPath(scopeKey), { force: true });
}

/** Constant-time compare, so a token check is not a timing oracle. */
export function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
