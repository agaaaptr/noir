import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { noirHome } from './layout.js';

export type InstallMethod =
  | 'native'
  | 'npm'
  | 'pnpm'
  | 'yarn'
  | 'bun'
  | 'homebrew'
  | 'scoop'
  | 'unknown';

export interface InstallRecord {
  method: InstallMethod;
  version: string;
  channel: string;
  installedAt: string;
  managedRuntimeVersion?: string;
  /** Per-version dismissals of the migration banner (C1 hardening). When the
   *  current CLI version is in this list, `shouldShowMigrationBanner` returns
   *  false — one nudge per version per non-native install. Absent ⇒ show. */
  dismissedVersions?: string[];
}

export function installJsonPath(): string {
  return process.env.NOIR_INSTALL_JSON ?? join(noirHome(), 'install.json');
}

/** Write a file atomically: write to a temp sibling, then rename into place.
 *  Never in-place overwrite (macOS code-sign inode-taint → SIGKILL; Windows
 *  locks).
 *
 *  NOTE: this does NOT call `fsync()` on the temp fd before the rename — the
 *  rename itself is atomic on POSIX, but a hard crash before the OS flushes
 *  the temp's dirty pages could leave a partially-written file visible at
 *  `path`. The trade-off is deliberate: the install/update caches and records
 *  this helper serves are recoverable (re-fetched / re-detected), so the extra
 *  fsync latency isn't justified. If a caller ever writes truly irrecoverable
 *  data through this helper, add an `fsync(fd)` + `close(fd)` path here and
 *  switch off `writeFileSync`. */
export function atomicWriteFile(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

export function writeInstallRecord(rec: InstallRecord): void {
  atomicWriteFile(installJsonPath(), `${JSON.stringify(rec, null, 2)}\n`);
}

export function readInstallRecord(): InstallRecord | null {
  try {
    const raw = readFileSync(installJsonPath(), 'utf8');
    const rec = JSON.parse(raw) as InstallRecord;
    if (typeof rec.method === 'string' && typeof rec.version === 'string') return rec;
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the install record file. Uses a direct `rmSync` (NOT a temp-then-
 * rename) intentionally: this is a DELETE, not a write — there is no
 * half-written intermediate state to guard against, and the same pattern is
 * used by `clearDaemonRecord` in the daemon. An atomic rename can't express
 * "this file no longer exists". */
export function clearInstallRecord(): void {
  const p = installJsonPath();
  if (existsSync(p)) rmSync(p, { force: true });
}
