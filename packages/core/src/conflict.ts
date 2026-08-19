// Shared conflict-resolution vocabulary + pure path helper, hoisted into core
// so the CLI/create/store/workflow/skills seams stop re-declaring the SAME
// 5-value union and `uniqueAside*` helper (the copies had already drifted:
// create's union carried a `merge` variant the others lacked). Every package
// except `model` already depends on core, so this removes the 4-way copy and
// the "no create dependency" workaround without a new edge.

import { existsSync } from 'node:fs';

/**
 * The 5-way conflict resolution a caller can pick when a write would clobber an
 * existing, differing file. `merge` is intentionally NOT here: it is a
 * create-engine-specific superset (3-way merge with conflict markers) that only
 * the scaffold resolver can produce — consumers of THIS type (store/workflow/
 * skills) never emit or accept `merge`.
 */
export type ConflictResolution = 'replace' | 'preserve' | 'rename' | 'duplicate' | 'cancel';

/** The resolver may return a bare {@link ConflictResolution} or a rich shape
 *  carrying `applyToAll` (apply the choice to the rest of this run's conflicts). */
export type ConflictResolverReturn =
  | ConflictResolution
  | { resolution: ConflictResolution; applyToAll?: boolean };

/** A pure, sync unique-path helper: `abs` + `suffix`, then `.1`, `.2`, … until a
 *  non-existing path is found. Used to move an existing file aside (`rename`) or
 *  write the proposed bytes to a sidecar (`duplicate`) without clobbering. */
export function uniqueAsideSync(abs: string, suffix: string): string {
  let candidate = `${abs}${suffix}`;
  for (let n = 1; existsSync(candidate); n++) candidate = `${abs}${suffix}.${n}`;
  return candidate;
}
