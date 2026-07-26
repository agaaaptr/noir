// SP-D follow-up — ancestor store for three-way managed-region merge.
//
// Persists the last-emitted managed-region text per (file, block) so a later
// `noir init`/`sync --merge` can three-way merge (base/ours/theirs) instead of
// strip-replacing. Stored at `.noir/ancestors.json` as a flat map. Only written
// when `ScaffoldOptions.mergeManagedRegions` is set (opt-in), so a default
// scaffold run never creates it.

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
 *  plain write (no tmp) is fine. */
export function writeAncestors(root: string, map: Record<string, string>): void {
  mkdirSync(dirname(ancestorsPath(root)), { recursive: true });
  writeFileSync(ancestorsPath(root), `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}
