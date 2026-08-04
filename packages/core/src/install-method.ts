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

/**
 * The native-install shim path: `~/.noir/bin/noir`. Stable across upgrades —
 * the installer rewrites the shim's CONTENTS (pointing at the latest managed
 * runtime + CLI) but never the path itself, so a `.mcp.json` that references
 * this absolute path keeps resolving after `noir update`.
 */
export function nativeShimPath(): string {
  return join(noirHome(), 'bin', 'noir');
}

/**
 * Resolve the `command` value a host's MCP config (`.mcp.json`) should use to
 * spawn the Noir server. GUI MCP clients (VS Code, Cursor) launch from the
 * Dock/Finder and do NOT read shell profiles, so `command: 'noir'` fails with
 * `spawn noir ENOENT` even when `~/.noir/bin` is on the user's shell PATH.
 *
 * When a native install is detected (`install.json` `method:'native'` AND the
 * shim file exists), return the absolute shim path — MCP clients can spawn an
 * absolute path with no PATH dependency. Otherwise fall back to `'noir'`
 * (works when `noir` is on PATH, e.g. an npm-global install in a terminal-spawn
 * client). Never throws: a missing/unreadable record degrades to `'noir'`.
 */
export function resolveNoirCommand(): string {
  // Env override for tests + CI: pin the command without requiring a native
  // install record on disk. NOT documented as a user knob — this is a test
  // seam. Production code relies on the install.json path below.
  if (process.env.NOIR_MCP_COMMAND) return process.env.NOIR_MCP_COMMAND;
  const rec = readInstallRecord();
  if (rec?.method === 'native' && existsSync(nativeShimPath())) {
    return nativeShimPath();
  }
  return 'noir';
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
