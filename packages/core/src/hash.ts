// sha256 helpers — single source of truth for the full-digest + 12-char short
// hash used across create/scaffold, cli/dedup-write, cli/task, and
// skills/compiler. The copies had drifted before (one fixed an ESM-incompatible
// lazy `require('crypto')` the others didn't), so this centralizes it.

import { createHash } from 'node:crypto';

/** Full sha256 hex digest of `s` (UTF-8). */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** sha256 hex truncated to the first 12 chars — the short, greppable form the
 *  conflict-path and scaffold records use. */
export function sha256Hex12(s: string): string {
  return sha256Hex(s).slice(0, 12);
}
