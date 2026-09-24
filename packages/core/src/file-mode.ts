import { chmodSync, statSync } from 'node:fs';

/** What a permission re-assert did — see {@link ensureOwnerOnly} and
 *  {@link ensureOwnerOnlyDir}. */
export type FileModeOutcome = 'unchanged' | 'healed' | 'unsupported';

/**
 * Re-assert owner-only (0600) permissions on a file that already exists,
 * returning what was done.
 *
 * Noir keeps several files that are private to the account that owns the repo:
 * the `.noir/.env` credential seed and the embedded store database (the whole
 * indexed context and memory index). Some are created by a writer that applies
 * 0600 at creation and never opens the file again; the database is created by
 * SQLite itself, which takes no creation mode. Either way a file seeded by an
 * older Noir, or rewritten by an editor that saves by rename, keeps a lax mode
 * (0644 — every other account on the machine can read it) indefinitely. This
 * re-asserts the mode whenever the owner opens the file, mirroring how the
 * install shim re-asserts its executable bit on every install.
 *
 * `healed` means group/other bits were present and the mode was tightened to
 * 0600; `unchanged` means the file was already owner-only, or is absent or
 * unreadable (nothing to heal); `unsupported` means the platform has no POSIX
 * mode bits (Windows permissions are ACL-based), where this degrades to a
 * no-op. Best-effort throughout — it never throws, because a permission it
 * cannot fix must not fail the command that would otherwise have succeeded.
 */
export function ensureOwnerOnly(absPath: string): FileModeOutcome {
  if (process.platform === 'win32') return 'unsupported';
  let mode: number;
  try {
    mode = statSync(absPath).mode & 0o777;
  } catch {
    return 'unchanged'; // absent or unreadable — nothing to heal
  }
  // Owner-only is the stated contract: any group or other bit is data readable
  // by another account, which is exactly the state being healed.
  if ((mode & 0o077) === 0) return 'unchanged';
  try {
    chmodSync(absPath, 0o600);
  } catch {
    return 'unchanged'; // best-effort; an unchangeable file stays as it was
  }
  return 'healed';
}

/**
 * The directory counterpart of {@link ensureOwnerOnly}: clear every group and
 * other permission bit from a directory that holds Noir's private data (the
 * store directory holds the project database), so no other account can list or
 * traverse it.
 *
 * Unlike the file case, the owner's own bits are NOT normalized to a fixed
 * value — only group/other bits are cleared, and the directory is left with the
 * owner bits it already had. Restoring owner write to a directory a person has
 * deliberately made read-only (a store on a read-only mount, an archived copy)
 * would silently undo that decision and hand back a writable store, whereas
 * dropping group/other access never changes what the owner can do.
 *
 * Same outcome contract as {@link ensureOwnerOnly}: `healed` means group/other
 * bits were present and were cleared, `unchanged` means the directory was
 * already owner-only, absent or unreadable, `unsupported` means the platform
 * has no POSIX mode bits. Best-effort — it never throws.
 */
export function ensureOwnerOnlyDir(absPath: string): FileModeOutcome {
  if (process.platform === 'win32') return 'unsupported';
  let mode: number;
  try {
    mode = statSync(absPath).mode & 0o777;
  } catch {
    return 'unchanged'; // absent or unreadable — nothing to heal
  }
  if ((mode & 0o077) === 0) return 'unchanged';
  try {
    chmodSync(absPath, mode & 0o700);
  } catch {
    return 'unchanged'; // best-effort; an unchangeable directory stays as it was
  }
  return 'healed';
}
