import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
 * Defense-in-depth vs the recurring "noir update → permission denied" bug.
 * `noir update` is run by the CURRENTLY-INSTALLED binary; if that binary
 * predates the chmod fix (or a future write path forgets to chmod), the shim
 * at {@link nativeShimPath} lands as 0o644 (no exec bit) and every subsequent
 * `noir …` fails with `permission denied`. This re-asserts 0o755 on the shim
 * whenever the CLI starts a write/install/update path, so a freshly-installed
 * binary (1.7.4+) heals its own shim even if the OLD updater that installed
 * it forgot to. Called after the shim write in installManagedNode() and from
 * the update path. Idempotent + best-effort; never throws.
 */
export function ensureShimExecutable(): void {
  const shim = nativeShimPath();
  try {
    const mode = statSync(shim).mode & 0o777;
    if (mode !== 0o755) chmodSync(shim, 0o755);
  } catch {
    // Absent or unreadable — nothing to heal (first install chmods explicitly).
  }
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
 *  Mode preservation (defense vs the "noir update → permission denied" bug):
 *  `writeFileSync` on a fresh temp yields the umask default (0o644, NO exec
 *  bit). If `path` already exists, the temp's mode replaces the target's on
 *  rename — so an overwrite of an executable shim (0o755) would lose the exec
 *  bit. This stat's the existing target BEFORE the write and re-applies its
 *  mode after the rename, so a rewrite keeps the original perms (matching
 *  `install -m` / rsync semantics). Callers writing a NEW exec file must still
 *  chmod explicitly (the shim write at installManagedNode does); this only
 *  preserves an existing exec file across a rewrite.
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
  // Stat the existing target (if any) so we can restore its mode after the
  // atomic rename — a rewrite must not silently strip the exec bit. The temp
  // file is written with umask (0o644); without this, `noir update` rewriting
  // the shim would make it non-executable (the recurring "permission denied").
  let prevMode: number | undefined;
  try {
    prevMode = statSync(path).mode & 0o777;
  } catch {
    // Absent on first write — nothing to preserve; caller chmods if exec.
  }
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
  if (prevMode !== undefined) {
    try {
      chmodSync(path, prevMode);
    } catch {
      // best-effort; a chmod failure on a rewritten file is non-fatal.
    }
  }
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
