// Ancestor store for three-way managed-region merge (SP-D, widened in B1).
//
// Persists the last-emitted managed-region text per (file, block) so a later
// `noir init`/`sync` can three-way merge (base/ours/theirs) instead of
// strip-replacing. Stored at `.noir/ancestors.json` as a flat map.
//
// B1: ancestor capture is UNCONDITIONAL (every init/create/sync writes a
// snapshot of the managed regions it touched), so the first merge run — now the
// DEFAULT — always has a base. `writeAncestors` is content-hash idempotent: a
// no-op sync leaves the file untouched (no mtime/git churn).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const ANCESTORS_REL = '.noir/ancestors.json';

/** Absolute path of the ancestor store under `root`. */
export function ancestorsPath(root: string): string {
  return join(root, ANCESTORS_REL);
}

/** Read the ancestor map (`{ "${relPath}::${blockBegin}": regionText }`).
 *  Returns `{}` for a missing/corrupt file (never throws). */
export function readAncestors(root: string): Record<string, string> {
  if (!existsSync(ancestorsPath(root))) return {};
  try {
    const raw = readFileSync(ancestorsPath(root), 'utf8');
    const obj: unknown = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, string>;
    }
    return {};
  } catch {
    return {};
  }
}

/** Write the ancestor map. Ensures `.noir/` exists (a standalone caller may
 *  invoke this before the scaffold has created the dir). Derived state, so the
 *  plain write (no tmp) is fine. B1: content-hash dedup — when the serialized
 *  bytes equal what is already on disk, the rewrite is skipped so a no-op sync
 *  leaves ancestors.json untouched (no mtime/git churn). */
export function writeAncestors(root: string, map: Record<string, string>): void {
  const path = ancestorsPath(root);
  const next = `${JSON.stringify(map, null, 2)}\n`;
  try {
    if (readFileSync(path, 'utf8') === next) return; // unchanged → skip
  } catch {
    /* missing → fall through to write */
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, next, 'utf8');
}
